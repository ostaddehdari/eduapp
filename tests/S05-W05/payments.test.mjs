import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createPaymentService } from '../../apps/commerce-service/src/payments.mjs';
import { applyCheckout, applyFeatureEntitlements, applyPaymentVerification, applyPlanCatalog,
  applyTenantIsolation, runSqlBootstrap } from '../../packages/data/src/migrate.mjs';

test('five signed callbacks yield one payment, ledger credit and entitlement across two tenants', { timeout: 60_000 }, async t => {
  const source = process.env.EDUAPP_S05_PAYMENT_PG_ADMIN_URL;
  assert(source, 'Set EDUAPP_S05_PAYMENT_PG_ADMIN_URL');
  const url = new URL(source);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s05_payment_test');
  assert.equal(url.search, '');
  const maintenanceUrl = new URL(url); maintenanceUrl.pathname = '/postgres';
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect(); t.after(() => maintenance.end());
  if (!(await maintenance.query('SELECT 1 FROM pg_database WHERE datname=$1', ['eduapp_s05_payment_test'])).rowCount) {
    await maintenance.query('CREATE DATABASE eduapp_s05_payment_test');
  }
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect(); t.after(() => admin.end());
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);
  const password = randomBytes(24).toString('hex');
  const migrant = randomBytes(24).toString('hex');
  await admin.query(`ALTER ROLE eduapp_billing_api PASSWORD '${password}'`);
  await admin.query(`ALTER ROLE eduapp_schema_migrator PASSWORD '${migrant}'`);
  const roleUrl = new URL(url); roleUrl.username = 'eduapp_schema_migrator'; roleUrl.password = migrant;
  const migrator = new pg.Client({ connectionString: roleUrl.href });
  await migrator.connect(); t.after(() => migrator.end());
  for (const apply of [applyTenantIsolation, applyPlanCatalog, applyFeatureEntitlements, applyCheckout,
    applyPaymentVerification]) assert.equal(await apply(migrator), true);
  assert.equal(await applyPaymentVerification(migrator), false);
  roleUrl.username = 'eduapp_billing_api'; roleUrl.password = password;
  const pool = new pg.Pool({ connectionString: roleUrl.href, max: 6 });
  t.after(() => pool.end());
  const tenantA = randomUUID(), tenantB = randomUUID();
  const { rows: [plan] } = await admin.query(`INSERT INTO commercial_billing.plans(code,status)
    VALUES ($1,'published') RETURNING id`, ['pay_' + randomBytes(6).toString('hex')]);
  const { rows: [version] } = await admin.query(`INSERT INTO commercial_billing.plan_versions
    (plan_id,version,price_minor,currency,effective_at,modules,quotas)
    VALUES ($1,1,100000,'IRR','2026-11-27T00:00:00Z','["school"]','{"seats":2}') RETURNING id`, [plan.id]);
  async function order(tenantId) {
    const { rows: [sub] } = await admin.query(`INSERT INTO commercial_billing.subscriptions
      (tenant_id,plan_version_id,status) VALUES ($1,$2,'pending_payment') RETURNING id`, [tenantId, version.id]);
    const { rows: [invoice] } = await admin.query(`INSERT INTO commercial_billing.invoices
      (tenant_id,subscription_id,amount_minor,currency,status)
      VALUES ($1,$2,100000,'IRR','pending_payment') RETURNING id`, [tenantId, sub.id]);
    const { rows: [checkout] } = await admin.query(`INSERT INTO commercial_billing.checkout_orders
      (tenant_id,request_key,request_hash,subscription_id,invoice_id,plan_version_id,modules,seats,amount_minor,currency)
      VALUES ($1,$2,$3,$4,$5,$6,'["school"]',2,100000,'IRR') RETURNING id`,
    [tenantId, randomUUID(), 'a'.repeat(64), sub.id, invoice.id, version.id]);
    return { orderId: checkout.id, invoiceId: invoice.id, subscriptionId: sub.id };
  }
  const a = await order(tenantA), b = await order(tenantB);
  const secret = randomBytes(32).toString('hex');
  const provider = { name: 'fixture',
    createIntent: async ({ invoiceId }) => ({ reference: 'ref_' + invoiceId.replaceAll('-', '') }),
    verify: async ({ reference }) => ({ paid: true, reference, amountMinor: '100000', currency: 'IRR' }),
  };
  const clock = () => new Date('2026-11-28T12:00:00Z');
  const payments = createPaymentService({ pool, provider, webhookSecret: secret, now: clock,
    authorize: ({ identity }) => identity.authorized });
  const identity = tenantId => ({ tenantId, scope: tenantId, authorized: true });
  const requestKey = randomUUID();
  const started = await payments.begin({ identity: identity(tenantA), orderId: a.orderId, requestKey });
  assert.equal((await payments.begin({ identity: identity(tenantA), orderId: a.orderId, requestKey })).replayed, true);
  await assert.rejects(payments.begin({ identity: identity(tenantB), orderId: a.orderId, requestKey: randomUUID() }), { message: 'NOT_FOUND' });
  await assert.rejects(payments.begin({ identity: { ...identity(tenantA), authorized: false }, orderId: a.orderId,
    requestKey: randomUUID() }), { message: 'FORBIDDEN' });
  const timestamp = Math.floor(clock().getTime() / 1000);
  function signed(event) {
    const rawBody = Buffer.from(JSON.stringify(event));
    return { rawBody, timestamp, signature: createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex') };
  }
  const event = n => signed({ tenantId: tenantA, attemptId: started.attemptId,
    provider: 'fixture', reference: started.providerReference, eventId: `callback_${n}` });
  await assert.rejects(payments.callback({ ...event(0), signature: '0'.repeat(64) }), { message: 'INVALID_SIGNATURE' });
  await assert.rejects(payments.callback(signed({ tenantId: tenantB, attemptId: started.attemptId,
    provider: 'fixture', reference: started.providerReference, eventId: 'foreign' })), { message: 'NOT_FOUND' });
  const outcomes = [];
  for (let n = 0; n < 5; n++) outcomes.push(await payments.callback(event(n)));
  assert.deepEqual(outcomes.map(x => x.replayed), [false, true, true, true, true]);
  await assert.rejects(payments.callback(signed({ tenantId: tenantA, attemptId: started.attemptId,
    provider: 'fixture', reference: 'other', eventId: 'callback_0' })), { message: 'NOT_FOUND' });
  for (const [table, where] of [
    ['payment_attempts', 'tenant_id=$1 AND status=\'verified\''],
    ['ledger_entries', 'tenant_id=$1 AND direction=\'credit\''],
    ['entitlements', 'tenant_id=$1 AND source_subscription_id IS NOT NULL'],
  ]) {
    assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM commercial_billing.${table} WHERE ${where}`, [tenantA])).rows[0].n, 1);
    assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM commercial_billing.${table} WHERE ${where}`, [tenantB])).rows[0].n, 0);
  }
  assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM commercial_billing.verified_callbacks
    WHERE tenant_id=$1`, [tenantA])).rows[0].n, 5);
  assert.equal((await admin.query('SELECT status FROM commercial_billing.subscriptions WHERE tenant_id=$1 AND id=$2',
    [tenantB, b.subscriptionId])).rows[0].status, 'pending_payment');
});

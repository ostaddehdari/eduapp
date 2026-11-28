import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createRefundService } from '../../apps/commerce-service/src/refunds.mjs';
import { applyCheckout, applyFeatureEntitlements, applyManagementDelegation, applyPaymentVerification,
  applyPlanCatalog, applyRefundAccounting, applyTenantIsolation, runSqlBootstrap } from '../../packages/data/src/migrate.mjs';

test('two distinct approvals create one compensating debit and read-only reconciliation detects drift', { timeout: 60_000 }, async t => {
  const source = process.env.EDUAPP_S05_REFUND_PG_ADMIN_URL;
  assert(source, 'Set EDUAPP_S05_REFUND_PG_ADMIN_URL');
  const url = new URL(source);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s05_refund_test');
  assert.equal(url.search, '');
  const maintenanceUrl = new URL(url); maintenanceUrl.pathname = '/postgres';
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect(); t.after(() => maintenance.end());
  if (!(await maintenance.query('SELECT 1 FROM pg_database WHERE datname=$1', ['eduapp_s05_refund_test'])).rowCount) {
    await maintenance.query('CREATE DATABASE eduapp_s05_refund_test');
  }
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect(); t.after(() => admin.end());
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);
  const migrant = randomBytes(24).toString('hex'), password = randomBytes(24).toString('hex');
  await admin.query(`ALTER ROLE eduapp_schema_migrator PASSWORD '${migrant}'`);
  await admin.query(`ALTER ROLE eduapp_billing_api PASSWORD '${password}'`);
  const roleUrl = new URL(url); roleUrl.username = 'eduapp_schema_migrator'; roleUrl.password = migrant;
  const migrator = new pg.Client({ connectionString: roleUrl.href });
  await migrator.connect(); t.after(() => migrator.end());
  for (const apply of [applyTenantIsolation, applyPlanCatalog, applyFeatureEntitlements, applyCheckout,
    applyPaymentVerification, applyManagementDelegation, applyRefundAccounting]) assert.equal(await apply(migrator), true);
  assert.equal(await applyRefundAccounting(migrator), false);
  roleUrl.username = 'eduapp_billing_api'; roleUrl.password = password;
  const pool = new pg.Pool({ connectionString: roleUrl.href, max: 4 });
  t.after(() => pool.end());
  const tenantA = randomUUID(), tenantB = randomUUID();
  const { rows: [plan] } = await admin.query(`INSERT INTO commercial_billing.plans(code,status)
    VALUES ($1,'published') RETURNING id`, ['refund_' + randomBytes(6).toString('hex')]);
  const { rows: [version] } = await admin.query(`INSERT INTO commercial_billing.plan_versions
    (plan_id,version,price_minor,currency,effective_at,modules,quotas)
    VALUES ($1,1,100000,'IRR','2026-11-27T00:00:00Z','["school"]','{"seats":1}') RETURNING id`, [plan.id]);
  async function paid(tenantId) {
    const { rows: [sub] } = await admin.query(`INSERT INTO commercial_billing.subscriptions
      (tenant_id,plan_version_id,status) VALUES ($1,$2,'active') RETURNING id`, [tenantId, version.id]);
    const { rows: [invoice] } = await admin.query(`INSERT INTO commercial_billing.invoices
      (tenant_id,subscription_id,amount_minor,currency,status) VALUES ($1,$2,100000,'IRR','paid') RETURNING id`, [tenantId, sub.id]);
    await admin.query(`INSERT INTO commercial_billing.checkout_orders
      (tenant_id,request_key,request_hash,subscription_id,invoice_id,plan_version_id,modules,seats,amount_minor,currency,status)
      VALUES ($1,$2,$3,$4,$5,$6,'["school"]',1,100000,'IRR','paid')`,
    [tenantId, randomUUID(), 'f'.repeat(64), sub.id, invoice.id, version.id]);
    await admin.query(`INSERT INTO commercial_billing.payment_attempts
      (tenant_id,invoice_id,idempotency_key,request_hash,status,provider,provider_reference)
      VALUES ($1,$2,$3,$4,'verified','fixture',$5)`,
    [tenantId, invoice.id, randomUUID(), 'f'.repeat(64), 'ref_' + randomBytes(8).toString('hex')]);
    await admin.query(`INSERT INTO commercial_billing.ledger_entries(tenant_id,invoice_id,direction,amount_minor)
      VALUES ($1,$2,'credit',100000)`, [tenantId, invoice.id]);
    await admin.query(`INSERT INTO commercial_billing.entitlements(tenant_id,feature,source_subscription_id)
      VALUES ($1,'school',$2)`, [tenantId, sub.id]);
    return { invoiceId: invoice.id, subscriptionId: sub.id };
  }
  const a = await paid(tenantA), b = await paid(tenantB);
  const calls = [];
  const provider = { name: 'fixture', async refund(input) {
    calls.push(input); return { refunded: true, reference: 'refund_' + input.idempotencyKey.replaceAll('-', '') };
  } };
  const service = createRefundService({ pool, provider, authorize: ({ identity, tenantId }) =>
    identity.allowedTenants?.includes(tenantId) === true });
  const actor = (allowedTenants = [tenantA]) => ({ actorId: randomUUID(), scope: 'identity-bootstrap', mfa: true, allowedTenants });
  const requester = actor(), first = actor(), second = actor();
  const requestKey = randomUUID();
  await assert.rejects(service.request({ identity: { ...requester, mfa: false }, tenantId: tenantA,
    invoiceId: a.invoiceId, requestKey }), { message: 'FORBIDDEN' });
  await assert.rejects(service.request({ identity: requester, tenantId: tenantB,
    invoiceId: b.invoiceId, requestKey }), { message: 'FORBIDDEN' });
  const requested = await service.request({ identity: requester, tenantId: tenantA, invoiceId: a.invoiceId, requestKey });
  assert.equal(requested.state, 'pending_first');
  assert.equal((await service.request({ identity: requester, tenantId: tenantA, invoiceId: a.invoiceId, requestKey })).replayed, true);
  await assert.rejects(service.approve({ identity: requester, tenantId: tenantA, refundId: requested.id }), { message: 'FORBIDDEN' });
  await assert.rejects(service.approve({ identity: first, tenantId: tenantB, refundId: requested.id }), { message: 'FORBIDDEN' });
  assert.equal((await service.approve({ identity: first, tenantId: tenantA, refundId: requested.id })).state, 'pending_second');
  assert.equal(calls.length, 0);
  await assert.rejects(service.approve({ identity: first, tenantId: tenantA, refundId: requested.id }), { message: 'FORBIDDEN' });
  assert.equal((await service.approve({ identity: second, tenantId: tenantA, refundId: requested.id })).state, 'refunded');
  assert.equal((await service.approve({ identity: second, tenantId: tenantA, refundId: requested.id })).state, 'refunded');
  assert.equal(calls.length, 1);
  assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM commercial_billing.ledger_entries
    WHERE tenant_id=$1 AND invoice_id=$2 AND direction='debit'`, [tenantA, a.invoiceId])).rows[0].n, 1);
  assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM commercial_billing.ledger_entries
    WHERE tenant_id=$1 AND invoice_id=$2 AND direction='credit'`, [tenantA, a.invoiceId])).rows[0].n, 1);
  assert.equal((await admin.query(`SELECT status FROM commercial_billing.subscriptions WHERE tenant_id=$1 AND id=$2`,
    [tenantA, a.subscriptionId])).rows[0].status, 'cancelled');
  assert((await admin.query(`SELECT valid_to FROM commercial_billing.entitlements WHERE tenant_id=$1`, [tenantA])).rows[0].valid_to);
  assert.deepEqual(await service.dashboard({ identity: actor([tenantA, tenantB]), tenantIds: [tenantA, tenantB] }), [
    { tenantId: tenantA, grossMinor: '100000', refundedMinor: '100000', netMinor: '0', payments: 1 },
    { tenantId: tenantB, grossMinor: '100000', refundedMinor: '0', netMinor: '100000', payments: 1 },
  ]);
  assert.deepEqual(await service.reconcile({ identity: requester, tenantId: tenantA }), []);
  await admin.query(`UPDATE commercial_billing.invoices SET status='paid' WHERE tenant_id=$1 AND id=$2`, [tenantA, a.invoiceId]);
  assert.deepEqual(await service.reconcile({ identity: requester, tenantId: tenantA }), [
    { invoiceId: a.invoiceId, status: 'paid', reason: 'LEDGER_OR_PROVIDER_MISMATCH' },
  ]);
  assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM commercial_billing.ledger_entries
    WHERE tenant_id=$1`, [tenantB])).rows[0].n, 1);
});

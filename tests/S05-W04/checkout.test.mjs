import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createCheckout } from '../../apps/commerce-service/src/checkout.mjs';
import { applyCheckout, applyFeatureEntitlements, applyPlanCatalog, applyTenantIsolation, runSqlBootstrap } from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';

test('orders, invoice, retry, grace and cancellation stay scoped to two tenants', { timeout: 45_000 }, async t => {
  const source = process.env.EDUAPP_S05_CHECKOUT_PG_ADMIN_URL;
  assert(source, 'Set EDUAPP_S05_CHECKOUT_PG_ADMIN_URL');
  const url = new URL(source);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s05_checkout_test');
  assert.equal(url.search, '');
  const maintenanceUrl = new URL(url); maintenanceUrl.pathname = '/postgres';
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect(); t.after(() => maintenance.end());
  if (!(await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', ['eduapp_s05_checkout_test'])).rowCount) {
    await maintenance.query('CREATE DATABASE eduapp_s05_checkout_test');
  }
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect(); t.after(() => admin.end());
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);
  const billPassword = randomBytes(24).toString('hex');
  const migratePassword = randomBytes(24).toString('hex');
  await admin.query(`ALTER ROLE eduapp_billing_api PASSWORD '${billPassword}'`);
  await admin.query(`ALTER ROLE eduapp_schema_migrator PASSWORD '${migratePassword}'`);
  const migratorUrl = new URL(url); migratorUrl.username = 'eduapp_schema_migrator'; migratorUrl.password = migratePassword;
  const migrator = new pg.Client({ connectionString: migratorUrl.href });
  await migrator.connect(); t.after(() => migrator.end());
  await applyTenantIsolation(migrator);
  await applyPlanCatalog(migrator);
  await applyFeatureEntitlements(migrator);
  assert.equal(await applyCheckout(migrator), true);
  assert.equal(await applyCheckout(migrator), false);
  const roleUrl = new URL(url); roleUrl.username = 'eduapp_billing_api'; roleUrl.password = billPassword;
  const pool = new pg.Pool({ connectionString: roleUrl.href, max: 4 });
  t.after(() => pool.end());
  const clock = () => new Date('2026-11-28T12:00:00Z');
  const checkout = createCheckout({ pool, now: clock,
    authorizeOrder: ({ identity }) => identity?.authorized === true,
    authorizeLifecycle: ({ identity }) => identity?.billingAgent === true,
  });
  const tenantA = randomUUID(), tenantB = randomUUID();
  const identity = tenantId => ({ tenantId, scope: tenantId, authorized: true, billingAgent: true });
  const { rows: [plan] } = await admin.query(`
    INSERT INTO commercial_billing.plans(code,status) VALUES ($1,'published') RETURNING id
  `, ['checkout_' + randomBytes(6).toString('hex')]);
  const { rows: [version] } = await admin.query(`
    INSERT INTO commercial_billing.plan_versions(plan_id,version,price_minor,currency,effective_at,modules,quotas,trial_days,term_days)
    VALUES ($1,1,100000,'IRR','2026-11-27T00:00:00Z','["school","attendance"]','{"seats":50}',14,365) RETURNING id
  `, [plan.id]);
  const request = { identity: identity(tenantA), planVersionId: version.id,
    modules: ['school'], seats: 12, requestKey: randomUUID() };
  const [first, second] = await Promise.all([checkout.order(request), checkout.order(request)]);
  assert.equal(first.id, second.id);
  assert.equal([first.replayed, second.replayed].filter(Boolean).length, 1);
  assert.equal(first.amountMinor, '100000');
  assert.equal(first.status, 'pending_payment');
  await assert.rejects(checkout.order({ ...request, seats: 13 }), { message: 'CONFLICT' });
  await assert.rejects(checkout.order({ ...request, requestKey: randomUUID(), seats: 51 }), { message: 'VALIDATION_FAILED' });
  await assert.rejects(checkout.order({ ...request, requestKey: randomUUID(), modules: ['foreign'] }), { message: 'VALIDATION_FAILED' });
  await assert.rejects(checkout.order({ ...request, identity: { ...identity(tenantA), authorized: false } }), { message: 'FORBIDDEN' });
  await assert.rejects(checkout.order({ ...request, identity: { ...identity(tenantA), scope: tenantB } }), { message: 'INVALID_REQUEST' });
  const other = await checkout.order({ ...request, identity: identity(tenantB) });
  assert.notEqual(other.id, first.id);
  const transactions = createTenantTransactions(pool);
  const foreign = await transactions.run(tenantB, db => db.query('SELECT id FROM commercial_billing.checkout_orders WHERE tenant_id = $1', [tenantA]));
  assert.equal(foreign.rowCount, 0);
  await assert.rejects(checkout.transition({ identity: identity(tenantB), orderId: first.id, action: 'cancel' }), { message: 'NOT_FOUND' });
  await assert.rejects(checkout.transition({ identity: identity(tenantA), orderId: first.id,
    action: 'grace', graceUntil: '2027-03-01T00:00:00Z' }), { message: 'INVALID_REQUEST' });
  const grace = await checkout.transition({ identity: identity(tenantA), orderId: first.id,
    action: 'grace', graceUntil: '2026-12-05T00:00:00Z' });
  assert.equal(grace.status, 'grace');
  const cancelled = await checkout.transition({ identity: identity(tenantA), orderId: first.id, action: 'cancel' });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await checkout.transition({ identity: identity(tenantA), orderId: first.id, action: 'cancel' })).status, 'cancelled');
  const { rows: [retained] } = await admin.query(`
    SELECT o.status, o.grace_until, s.status AS subscription_status, i.status AS invoice_status,
      i.amount_minor FROM commercial_billing.checkout_orders o
    JOIN commercial_billing.subscriptions s ON s.id = o.subscription_id AND s.tenant_id = o.tenant_id
    JOIN commercial_billing.invoices i ON i.id = o.invoice_id AND i.tenant_id = o.tenant_id
    WHERE o.tenant_id = $1 AND o.id = $2
  `, [tenantA, first.id]);
  assert.equal(retained.subscription_status, 'cancelled');
  assert.equal(retained.invoice_status, 'cancelled');
  assert.equal(retained.amount_minor, '100000');
  assert(retained.grace_until);
  assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM commercial_billing.invoices
    WHERE tenant_id = $1`, [tenantA])).rows[0].n, 1);
});

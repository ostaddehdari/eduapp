import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import process from 'node:process';
import { test } from 'node:test';
import { URL } from 'node:url';
import pg from 'pg';
import { createEntitlementService } from '../../apps/commerce-service/src/entitlements.mjs';
import {
  applyFeatureEntitlements, applyPlanCatalog, applyTenantIsolation, runSqlBootstrap,
} from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';

test('paid feature access requires a flag, active grant and independent permission', { timeout: 45_000 }, async t => {
  const url = new URL(process.env.EDUAPP_S05_ENTITLEMENT_PG_ADMIN_URL ?? '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s05_entitlement_test');
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  t.after(() => maintenance.end());
  if (!(await maintenance.query('SELECT 1 FROM pg_database WHERE datname=$1',
    ['eduapp_s05_entitlement_test'])).rowCount) {
    await maintenance.query('CREATE DATABASE eduapp_s05_entitlement_test');
  }
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  t.after(() => admin.end());
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);
  const roleUrl = new URL(url);
  roleUrl.username = 'eduapp_billing_api';
  roleUrl.password = randomBytes(24).toString('hex');
  await admin.query(`ALTER ROLE eduapp_billing_api PASSWORD '${roleUrl.password}'`);
  const migratorUrl = new URL(url);
  migratorUrl.username = 'eduapp_schema_migrator';
  migratorUrl.password = randomBytes(24).toString('hex');
  await admin.query(`ALTER ROLE eduapp_schema_migrator PASSWORD '${migratorUrl.password}'`);
  const migrator = new pg.Client({ connectionString: migratorUrl.href });
  await migrator.connect();
  t.after(() => migrator.end());
  await applyTenantIsolation(migrator);
  await applyPlanCatalog(migrator);
  assert.equal(await applyFeatureEntitlements(migrator), true);
  assert.equal(await applyFeatureEntitlements(migrator), false);

  const tenantA = randomUUID(), tenantB = randomUUID();
  const { rows: [plan] } = await admin.query("INSERT INTO commercial_billing.plans(code,status) VALUES('entitlement_plan','published') RETURNING id");
  const { rows: [revision] } = await admin.query(`
    INSERT INTO commercial_billing.plan_versions(plan_id,version,price_minor,currency,effective_at)
    VALUES ($1,1,100,'IRR',now()) RETURNING id
  `, [plan.id]);
  const { rows: [subscription] } = await admin.query(`
    INSERT INTO commercial_billing.subscriptions(tenant_id,plan_version_id,status)
    VALUES ($1,$2,'active') RETURNING id
  `, [tenantA, revision.id]);
  await admin.query(`INSERT INTO commercial_billing.feature_flags(feature,enabled)
    VALUES ('attendance',false)`);
  await admin.query(`INSERT INTO commercial_billing.entitlements(tenant_id,feature,limit_value)
    VALUES ($1,'attendance',500)`, [tenantA]);
  const pool = new pg.Pool({ connectionString: roleUrl.href, max: 5 });
  t.after(() => pool.end());
  const actor = randomUUID();
  const identity = tenantId => ({ actor, tenantId, scope: tenantId });
  const access = createEntitlementService({ pool, now: () => new Date('2026-11-28T12:00:00Z'),
    authorizePermission: ({ identity: principal, action }) => principal?.actor === actor && action === 'attendance.use',
  });
  assert.equal(await access.check({ identity: identity(tenantA), feature: 'attendance', action: 'attendance.use' }), false,
    'Legacy grants must not activate a feature');
  await admin.query(`INSERT INTO commercial_billing.entitlements
    (tenant_id,feature,limit_value,source_subscription_id,valid_from)
    VALUES ($1,'attendance',2,$2,'2026-11-27T00:00:00Z')`, [tenantA, subscription.id]);
  assert.equal(await access.hasEntitlement({ tenantId: tenantA, feature: 'attendance' }), false);
  await admin.query("UPDATE commercial_billing.feature_flags SET enabled=true, revision=2 WHERE feature='attendance'");
  assert.equal(await access.check({ identity: identity(tenantA), feature: 'attendance', action: 'wrong.action' }), false);
  assert.equal(await access.check({ identity: { ...identity(tenantA), scope: tenantB },
    feature: 'attendance', action: 'attendance.use' }), false);
  assert.equal(await access.check({ identity: identity(tenantB), feature: 'attendance', action: 'attendance.use' }), false);
  assert.equal(await access.check({ identity: identity(tenantA), feature: 'attendance', action: 'attendance.use' }), true);

  const requestKey = randomUUID();
  const call = { identity: identity(tenantA), feature: 'attendance', action: 'attendance.use', requestKey, amount: 2 };
  assert.deepEqual(await access.reserve(call), { used: '2', replayed: false });
  assert.deepEqual(await access.reserve(call), { used: '2', replayed: true });
  await assert.rejects(access.reserve({ ...call, amount: 1 }), { message: 'CONFLICT' });
  await assert.rejects(access.reserve({ ...call, requestKey: randomUUID(), amount: 1 }), { message: 'FORBIDDEN' });
  assert.equal(await access.hasEntitlement({ tenantId: tenantA, feature: 'attendance' }), false);
  const tx = createTenantTransactions(pool);
  assert.equal((await tx.run(tenantB, db => db.query(
    'SELECT * FROM commercial_billing.usage_counters WHERE tenant_id=$1', [tenantA]))).rowCount, 0);
  await assert.rejects(pool.query("UPDATE commercial_billing.feature_flags SET enabled=false"), { code: '42501' });

  const { rows: [subscriptionB] } = await admin.query(`
    INSERT INTO commercial_billing.subscriptions(tenant_id,plan_version_id,status)
    VALUES ($1,$2,'active') RETURNING id
  `, [tenantB, revision.id]);
  await admin.query(`INSERT INTO commercial_billing.entitlements
    (tenant_id,feature,limit_value,source_subscription_id,valid_from)
    VALUES ($1,'attendance',1,$2,'2026-11-27T00:00:00Z')`, [tenantB, subscriptionB.id]);
  const parallel = await Promise.allSettled([randomUUID(), randomUUID()].map(key => access.reserve({
    identity: identity(tenantB), feature: 'attendance', action: 'attendance.use', requestKey: key,
  })));
  assert.deepEqual(parallel.map(result => result.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(parallel.find(result => result.status === 'rejected').reason.message, 'FORBIDDEN');
  await admin.query("UPDATE commercial_billing.subscriptions SET status='cancelled' WHERE tenant_id=$1", [tenantB]);
  assert.equal(await access.hasEntitlement({ tenantId: tenantB, feature: 'attendance' }), false);
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createDelegationService } from '../../apps/commerce-service/src/delegations.mjs';
import { applyCheckout, applyFeatureEntitlements, applyManagementDelegation, applyPaymentVerification,
  applyPlanCatalog, applyTenantIsolation, runSqlBootstrap } from '../../packages/data/src/migrate.mjs';

test('paid seats require owner approval, exact scope and expiry; revocation is immediate', { timeout: 60_000 }, async t => {
  const source = process.env.EDUAPP_S05_DELEGATION_PG_ADMIN_URL;
  assert(source, 'Set EDUAPP_S05_DELEGATION_PG_ADMIN_URL');
  const url = new URL(source);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s05_delegation_test');
  assert.equal(url.search, '');
  const maintenanceUrl = new URL(url); maintenanceUrl.pathname = '/postgres';
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect(); t.after(() => maintenance.end());
  if (!(await maintenance.query('SELECT 1 FROM pg_database WHERE datname=$1', ['eduapp_s05_delegation_test'])).rowCount) {
    await maintenance.query('CREATE DATABASE eduapp_s05_delegation_test');
  }
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect(); t.after(() => admin.end());
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);
  const password = randomBytes(24).toString('hex'), migrant = randomBytes(24).toString('hex');
  await admin.query(`ALTER ROLE eduapp_billing_api PASSWORD '${password}'`);
  await admin.query(`ALTER ROLE eduapp_schema_migrator PASSWORD '${migrant}'`);
  const roleUrl = new URL(url); roleUrl.username = 'eduapp_schema_migrator'; roleUrl.password = migrant;
  const migrator = new pg.Client({ connectionString: roleUrl.href });
  await migrator.connect(); t.after(() => migrator.end());
  for (const apply of [applyTenantIsolation, applyPlanCatalog, applyFeatureEntitlements, applyCheckout,
    applyPaymentVerification, applyManagementDelegation]) assert.equal(await apply(migrator), true);
  assert.equal(await applyManagementDelegation(migrator), false);
  roleUrl.username = 'eduapp_billing_api'; roleUrl.password = password;
  const pool = new pg.Pool({ connectionString: roleUrl.href, max: 4 });
  t.after(() => pool.end());
  const tenantA = randomUUID(), tenantB = randomUUID(), ownerA = randomUUID(), ownerB = randomUUID();
  const delegate = randomUUID(), scopeA = randomUUID(), scopeB = randomUUID();
  const { rows: [plan] } = await admin.query(`INSERT INTO commercial_billing.plans(code,status)
    VALUES ($1,'published') RETURNING id`, ['deleg_' + randomBytes(6).toString('hex')]);
  const { rows: [version] } = await admin.query(`INSERT INTO commercial_billing.plan_versions
    (plan_id,version,price_minor,currency,effective_at,modules,quotas)
    VALUES ($1,1,100000,'IRR','2026-11-27T00:00:00Z','["school"]','{"seats":1}') RETURNING id`, [plan.id]);
  async function order(tenantId, status) {
    const { rows: [sub] } = await admin.query(`INSERT INTO commercial_billing.subscriptions
      (tenant_id,plan_version_id,status) VALUES ($1,$2,$3) RETURNING id`,
    [tenantId, version.id, status === 'paid' ? 'active' : status]);
    const { rows: [invoice] } = await admin.query(`INSERT INTO commercial_billing.invoices
      (tenant_id,subscription_id,amount_minor,currency,status) VALUES ($1,$2,100000,'IRR',$3) RETURNING id`,
    [tenantId, sub.id, status]);
    await admin.query(`INSERT INTO commercial_billing.checkout_orders
      (tenant_id,request_key,request_hash,subscription_id,invoice_id,plan_version_id,modules,seats,amount_minor,currency,status)
      VALUES ($1,$2,$3,$4,$5,$6,'["school"]',1,100000,'IRR',$7)`,
    [tenantId, randomUUID(), 'b'.repeat(64), sub.id, invoice.id, version.id, status]);
    return sub.id;
  }
  const paid = await order(tenantA, 'paid'), pending = await order(tenantB, 'pending_payment');
  let instant = new Date('2026-11-28T12:00:00Z');
  const service = createDelegationService({ pool, now: () => instant,
    resolveOwner: async ({ tenantId }) => tenantId === tenantA ? ownerA : ownerB,
    scopeExists: async ({ tenantId, scopeOrgId }) => tenantId === tenantA && scopeOrgId === scopeA,
    authorizePurchase: async ({ identity }) => identity.canBuy === true,
    authorizeOwner: async ({ identity }) => identity.mfa === true,
  });
  const person = (tenantId, actorId, extra = {}) => ({ tenantId, scope: tenantId, actorId, ...extra });
  const purchaser = person(tenantA, randomUUID(), { canBuy: true });
  const target = person(tenantA, delegate);
  const expiresAt = '2026-12-01T12:00:00Z';
  await assert.rejects(service.request({ identity: person(tenantB, ownerB, { canBuy: true }), subscriptionId: pending,
    delegateIdentityId: delegate, scopeOrgId: scopeA, expiresAt, requestKey: randomUUID() }), { message: 'NOT_FOUND' });
  const key = randomUUID();
  const first = await service.request({ identity: purchaser, subscriptionId: paid,
    delegateIdentityId: delegate, scopeOrgId: scopeA, expiresAt, requestKey: key });
  assert.equal(first.approvedAt, null);
  assert.equal((await service.request({ identity: purchaser, subscriptionId: paid,
    delegateIdentityId: delegate, scopeOrgId: scopeA, expiresAt, requestKey: key })).replayed, true);
  assert.equal(await service.canManage({ identity: target, scopeOrgId: scopeA }), false);
  await assert.rejects(service.request({ identity: purchaser, subscriptionId: paid,
    delegateIdentityId: randomUUID(), scopeOrgId: scopeA, expiresAt, requestKey: randomUUID() }), { message: 'SEATS_EXHAUSTED' });
  await assert.rejects(service.decide({ identity: person(tenantA, randomUUID(), { mfa: true }),
    delegationId: first.id, action: 'approve' }), { message: 'FORBIDDEN' });
  await assert.rejects(service.decide({ identity: person(tenantA, ownerA),
    delegationId: first.id, action: 'approve' }), { message: 'FORBIDDEN' });
  const owner = person(tenantA, ownerA, { mfa: true });
  assert((await service.decide({ identity: owner, delegationId: first.id, action: 'approve' })).approvedAt);
  assert.equal(await service.canManage({ identity: target, scopeOrgId: scopeA }), true);
  assert.equal(await service.canManage({ identity: target, scopeOrgId: scopeB }), false);
  assert.equal(await service.canManage({ identity: person(tenantB, delegate), scopeOrgId: scopeA }), false);
  await service.decide({ identity: owner, delegationId: first.id, action: 'revoke' });
  assert.equal(await service.canManage({ identity: target, scopeOrgId: scopeA }), false);
  assert.equal((await admin.query(`SELECT count(*)::integer AS n FROM commercial_billing.management_delegations
    WHERE tenant_id=$1`, [tenantA])).rows[0].n, 1);
  assert.equal((await admin.query(`SELECT status FROM commercial_billing.subscriptions WHERE tenant_id=$1 AND id=$2`,
    [tenantA, paid])).rows[0].status, 'active');
  const second = await service.request({ identity: purchaser, subscriptionId: paid,
    delegateIdentityId: randomUUID(), scopeOrgId: scopeA, expiresAt, requestKey: randomUUID() });
  await service.decide({ identity: owner, delegationId: second.id, action: 'approve' });
  instant = new Date(expiresAt);
  assert.equal(await service.canManage({ identity: person(tenantA, second.delegateIdentityId), scopeOrgId: scopeA }), false);
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import process from 'node:process';
import { test } from 'node:test';
import { URL } from 'node:url';
import pg from 'pg';
import { createGateway, GatewayError } from '../../apps/api-gateway/src/gateway.mjs';
import { createPostgresAccessRepository } from '../../apps/identity-service/src/access/repository.mjs';
import { createAccessService } from '../../apps/identity-service/src/access/service.mjs';
import { createAccessRepository } from '../../apps/identity-service/src/people/access-repository.mjs';
import { createManagementReadPorts, createManagementRoutes, createManagementService } from '../../apps/tenant-org-service/src/management.mjs';
import {
  applyAccessInvitations, applyAccessPolicy, applyManagementPanel, applyOrganizationTree, applyTenantIsolation,
  applyTenantRegistry, runSqlBootstrap,
} from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';

const fixtureName = 'eduapp_s04_management_test';
const environmentKey = 'EDUAPP_S04_MANAGEMENT_PG_ADMIN_URL';
const txRoles = ['eduapp_schema_migrator', 'eduapp_tenancy_api', 'eduapp_access_api', 'eduapp_billing_api'];

async function setup(t) {
  assert.ok(process.env[environmentKey], 'Set a local management fixture PostgreSQL URL');
  let url;
  try { url = new URL(process.env[environmentKey]); } catch { throw new TypeError('Use a PostgreSQL fixture URL'); }
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/' + fixtureName);
  assert.ok(!url.search && !url.hash);
  const connect = async connectionString => {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 3_000 });
    await client.connect();
    t.after(() => client.end());
    return client;
  };
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  const maintenance = await connect(maintenanceUrl.href);
  if (!(await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [fixtureName])).rowCount) {
    await maintenance.query('CREATE DATABASE eduapp_s04_management_test');
  }
  const admin = await connect(url.href);
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);
  const credentials = new Map();
  for (const role of txRoles) {
    const secret = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${secret}'`);
    const roleUrl = new URL(url);
    roleUrl.username = role;
    roleUrl.password = secret;
    credentials.set(role, roleUrl.href);
  }
  const migrator = await connect(credentials.get('eduapp_schema_migrator'));
  for (const apply of [applyTenantIsolation, applyAccessInvitations, applyAccessPolicy, applyTenantRegistry,
    applyOrganizationTree, applyManagementPanel]) await apply(migrator);
  assert.equal(await applyManagementPanel(migrator), false);
  const tx = role => {
    const pool = new pg.Pool({ connectionString: credentials.get(role), connectionTimeoutMillis: 3_000, max: 4 });
    t.after(() => pool.end());
    return createTenantTransactions(pool);
  };
  return { admin, tenancy: tx('eduapp_tenancy_api'), access: tx('eduapp_access_api'), billing: tx('eduapp_billing_api') };
}

function platformIdentity(actor = randomUUID()) {
  return { actor, identityId: actor, sessionId: randomUUID(), scope: 'identity-bootstrap', tenantId: null, membershipId: null, orgUnitId: null };
}

test('platform and organization management stay scoped and apply status with independent approval', { timeout: 45_000 }, async t => {
  const { admin, tenancy, access, billing } = await setup(t);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const branchA = randomUUID();
  const siblingA = randomUUID();
  const branchB = randomUUID();
  for (const [tenant, name] of [[tenantA, 'Tenant alpha'], [tenantB, 'Tenant beta']]) {
    await admin.query(`INSERT INTO tenancy_organization.tenants
      (id, slug, display_name, status, owner_identity_id, owner_membership_id)
      VALUES ($1, $2, $3, 'active', $4, $5)`, [tenant, `fixture-${tenant}`, name, randomUUID(), randomUUID()]);
  }
  for (const [tenant, id, code] of [[tenantA, branchA, 'north'], [tenantA, siblingA, 'south'], [tenantB, branchB, 'foreign']]) {
    await admin.query(`INSERT INTO tenancy_organization.org_units (tenant_id, id, kind, code, name)
      VALUES ($1, $2, 'school', $3, $3)`, [tenant, id, code]);
  }
  await admin.query(`INSERT INTO commercial_billing.entitlements (tenant_id, feature, limit_value, valid_to) VALUES
    ($1, 'learners', '9223372036854775000', NULL), ($1, 'storage', NULL, NULL),
    ($1, 'expired', 2, statement_timestamp() - interval '1 day'), ($2,'private_quota', 2, NULL)`, [tenantA, tenantB]);

  async function member(tenantId, orgUnitId, roleName, rules, status = 'active') {
    const actor = randomUUID();
    const membershipId = randomUUID();
    const roleId = randomUUID();
    await admin.query(`INSERT INTO identity_access.memberships (tenant_id,id,identity_id,org_unit_id,status)
      VALUES ($1,$2,$3,$4,$5)`, [tenantId, membershipId, actor, orgUnitId, status]);
    await admin.query('INSERT INTO identity_access.roles (tenant_id,id,name,version,rules) VALUES ($1,$2,$3,1,$4::jsonb)',
      [tenantId, roleId, roleName, JSON.stringify(rules)]);
    await admin.query(`INSERT INTO identity_access.role_bindings (tenant_id,membership_id,role_id,scope_org_id)
      VALUES ($1,$2,$3,$4)`, [tenantId, membershipId, roleId, orgUnitId]);
    return { actor, identityId: actor, tenantId, scope: tenantId, membershipId, sessionId: randomUUID(), orgUnitId };
  }
  const allow = action => ({ action, effect: 'allow', relationship: null, fields: [] });
  const read = ['tenancy.tenant.read', 'tenancy.org.read'].map(allow);
  const manage = [...read, allow('access.invitation.create')];
  const org = await member(tenantA, null, `Org manager ${tenantA}`, manage);
  const branch = await member(tenantA, branchA, `Branch manager ${tenantA}`, manage);
  const sibling = await member(tenantA, siblingA, `Sibling ${tenantA}`, manage);
  const denied = await member(tenantA, branchA, `Blocked ${tenantA}`, [...manage, { ...allow('access.invitation.create'), effect: 'deny' }]);
  await member(tenantA, branchA, `Inactive ${tenantA}`, manage, 'revoked');
  const foreign = await member(tenantB, branchB, `Foreign ${tenantB}`, manage);
  const noRead = await member(tenantA, branchA, `Insufficient ${tenantA}`, [allow('tenancy.org.read')]);
  const membership = createAccessRepository({ transactions: access });
  const accessService = createAccessService({ repository: createPostgresAccessRepository({ transactions: access }),
    resolveMembership: membership.resolveMembership });
  const requester = platformIdentity();
  const reviewer = platformIdentity();
  const outsider = platformIdentity();
  const pins = new Map([[requester.actor, [{ tenantId: tenantA, requestStatusChange: true, decideStatusChange: true }]],
    [reviewer.actor, [{ tenantId: tenantA, requestStatusChange: false, decideStatusChange: true }]]]);
  const fresh = new Set([requester.sessionId, reviewer.sessionId]);
  const readPorts = createManagementReadPorts({ billingTransactions: billing, accessTransactions: access });
  const service = createManagementService({ transactions: tenancy,
    authorize: ({ identity, ...target }) => accessService.can(identity, target),
    resolvePlatformScopes: ({ identity }) => pins.get(identity.actor) ?? [],
    requireRecentMfa: identity => fresh.has(identity.sessionId), ...readPorts,
  });
  const principal = new Map([['requester', requester], ['reviewer', reviewer], ['outsider', outsider],
    ['org', org], ['branch', branch], ['none', noRead]]);
  const gateway = createServer(createGateway({
    authenticate: value => principal.get(value?.replace(/^Bearer /, '')),
    routes: createManagementRoutes({ service, GatewayError }),
  }));
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => gateway.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${gateway.address().port}/v1/management`;
  async function call(who, path, body, headers = {}) {
    const response = await globalThis.fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...(who && { authorization: 'Bearer ' + who }), ...(body && { 'content-type': 'application/json' }), ...headers },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, requestId: response.headers.get('x-request-id'), ...(await response.json()) };
  }
  const overview = (name, tenantId, headers) => call(name, '/overview' + (tenantId ? `?tenantId=${tenantId}` : ''), null, headers);
  const request = (who, tenantId, targetStatus, expectedVersion) => call(who, '/status-requests', { tenantId, targetStatus, expectedVersion });
  const decide = (who, tenantId, id, decision) => call(who, `/status-requests/${id}/decision`, { tenantId, decision });

  await t.test('platform allowlist and tenant or exact branch session constrain all owner projections', async () => {
    assert.equal((await overview(null)).status, 401);
    assert.equal((await overview('outsider')).status, 403);
    assert.equal((await overview('requester', tenantB)).status, 404);
    const list = await overview('requester');
    assert.equal(list.status, 200);
    assert.equal(list.data.mode, 'platform');
    assert.deepEqual(list.data.tenants.map(item => item.id), [tenantA]);
    assert.equal(list.data.selected, null);
    assert.deepEqual(Object.keys(list.data.tenants[0]).sort(), ['displayName', 'id', 'slug', 'status', 'version']);

    assert.equal((await overview('org', tenantB)).status, 404);
    assert.equal((await overview('none')).status, 403);
    const scoped = await overview('org', tenantA, { 'x-tenant-id': tenantB });
    assert.equal(scoped.status, 200);
    assert.equal(scoped.data.mode, 'organization');
    assert.equal(scoped.data.selected.tenant.id, tenantA);
    assert.deepEqual(scoped.data.selected.branches.map(unit => unit.id), [branchA, siblingA]);
    assert.deepEqual(scoped.data.selected.quotas, [
      { feature: 'learners', limit: '9223372036854775000', validTo: null },
      { feature: 'storage', limit: null, validTo: null },
    ]);
    assert.deepEqual(scoped.data.selected.managers.map(manager => manager.membershipId).sort(),
      [org.membershipId, branch.membershipId, sibling.membershipId].sort());
    assert.ok(scoped.data.selected.managers.every(manager => !Object.hasOwn(manager, 'identityId')));
    assert.ok(!scoped.data.selected.managers.some(manager => [foreign.membershipId, denied.membershipId].includes(manager.membershipId)));

    const exact = await overview('branch');
    assert.equal(exact.status, 200);
    assert.deepEqual(exact.data.selected.branches.map(unit => [unit.id, unit.parentId]), [[branchA, null]]);
    assert.deepEqual(exact.data.selected.managers.map(manager => manager.membershipId), [branch.membershipId]);
    assert.deepEqual(exact.data.selected.quotas, []);
    assert.deepEqual(exact.data.selected.approvals, []);
    assert.equal((await request('org', tenantA, 'suspended', 1)).status, 403);
  });

  await t.test('MFA, separate reviewer, racing updates and immutable audit constrain changes', async () => {
    fresh.delete(requester.sessionId);
    assert.equal((await request('requester', tenantA, 'suspended', 1)).status, 403);
    fresh.add(requester.sessionId);
    assert.equal((await request('requester', tenantB, 'suspended', 1)).status, 403);
    assert.equal((await request('requester', tenantA, 'suspended', 2)).status, 412);
    assert.equal((await request('reviewer', tenantA, 'suspended', 1)).status, 403);
    const requests = await Promise.all([request('requester', tenantA, 'suspended', 1), request('requester', tenantA, 'suspended', 1)]);
    assert.deepEqual(requests.map(result => result.status).sort(), [201, 409]);
    const accepted = requests.find(result => result.status === 201);
    const approvalId = accepted.data.id;
    assert.equal(accepted.data.state, 'pending');
    assert.equal((await decide('requester', tenantA, approvalId, 'approve')).status, 403);
    assert.equal((await overview('requester', tenantA)).data.selected.approvals[0].canDecide, false);
    assert.equal((await overview('reviewer', tenantA)).data.selected.approvals[0].canDecide, true);
    assert.equal((await overview('org')).data.selected.approvals.length, 0);
    const otherTenantRows = await tenancy.run(tenantB, db => db.query(
      'SELECT id FROM tenancy_organization.management_status_requests WHERE id = $1', [approvalId],
    ));
    assert.equal(otherTenantRows.rowCount, 0);
    fresh.delete(reviewer.sessionId);
    assert.equal((await decide('reviewer', tenantA, approvalId, 'approve')).status, 403);
    fresh.add(reviewer.sessionId);
    const results = await Promise.all([decide('reviewer', tenantA, approvalId, 'approve'), decide('reviewer', tenantA, approvalId, 'approve')]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
    const approved = results.find(result => result.status === 200);
    assert.equal(approved.data.state, 'approved');
    const suspended = await overview('reviewer', tenantA);
    assert.equal(suspended.data.selected.tenant.status, 'suspended');
    assert.equal(suspended.data.selected.tenant.version, 2);
    assert.equal((await overview('org')).status, 404);
    const { rows: audit } = await admin.query(`SELECT request_id, actor_id, requester_id, outcome, result_version
      FROM tenancy_organization.management_status_audit WHERE tenant_id = $1 AND approval_id = $2 ORDER BY result_version`, [tenantA, approvalId]);
    assert.deepEqual(audit, [
      { request_id: accepted.requestId, actor_id: requester.actor, requester_id: requester.actor, outcome: 'requested', result_version: 1 },
      { request_id: approved.requestId, actor_id: reviewer.actor, requester_id: requester.actor, outcome: 'approved', result_version: 2 },
    ]);
    await assert.rejects(tenancy.run(tenantA, db => db.query('DELETE FROM tenancy_organization.management_status_audit')), { code: '42501' });
    assert.equal((await admin.query('SELECT status FROM tenancy_organization.tenants WHERE id=$1', [tenantB])).rows[0].status, 'active');

    const rejectable = await request('requester', tenantA, 'active', 2);
    assert.equal((await decide('reviewer', tenantA, rejectable.data.id, 'reject')).data.state, 'rejected');
    assert.equal((await overview('reviewer', tenantA)).data.selected.tenant.version, 2);
    const nowStale = await request('requester', tenantA, 'active', 2);
    await admin.query('UPDATE tenancy_organization.tenants SET version=3 WHERE id=$1', [tenantA]);
    assert.equal((await decide('reviewer', tenantA, nowStale.data.id, 'approve')).data.state, 'stale');
    assert.equal((await overview('reviewer', tenantA)).data.selected.tenant.status, 'suspended');
    const reactivate = await request('requester', tenantA, 'active', 3);
    assert.equal((await decide('reviewer', tenantA, reactivate.data.id, 'approve')).data.state, 'approved');
    assert.equal((await overview('org')).data.selected.tenant.status, 'active');
  });
});

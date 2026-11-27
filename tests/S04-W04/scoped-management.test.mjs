import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import pg from 'pg';
import { createGateway, GatewayError } from '../../apps/api-gateway/src/gateway.mjs';
import { createPostgresAccessRepository } from '../../apps/identity-service/src/access/repository.mjs';
import { createAccessAuthorize, createAccessService } from '../../apps/identity-service/src/access/service.mjs';
import { createAccessRepository } from '../../apps/identity-service/src/people/access-repository.mjs';
import { createPeopleRoutes } from '../../apps/identity-service/src/people/gateway-routes.mjs';
import { createPeopleService } from '../../apps/identity-service/src/people/people-service.mjs';
import { createOrganizationTree } from '../../apps/tenant-org-service/src/tree.mjs';
import {
  applyAccessInvitations, applyAccessPolicy, applyOrganizationTree, applyScopedOrgManagement,
  applyTenantIsolation, applyTenantRegistry, runSqlBootstrap,
} from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';

const fixtureName = 'eduapp_s04_scope_test';

async function setup(t) {
  assert(process.env.EDUAPP_S04_SCOPE_PG_ADMIN_URL, 'Set EDUAPP_S04_SCOPE_PG_ADMIN_URL');
  const url = new URL(process.env.EDUAPP_S04_SCOPE_PG_ADMIN_URL);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/' + fixtureName);
  assert.equal(url.search, '');
  const connect = async (connectionString) => {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 3000 });
    await client.connect();
    t.after(() => client.end());
    return client;
  };
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  const maintenance = await connect(maintenanceUrl.href);
  if (!(await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [fixtureName])).rowCount) {
    await maintenance.query('CREATE DATABASE ' + fixtureName);
  }
  const admin = await connect(url.href);
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);
  const credentials = new Map();
  for (const role of ['eduapp_schema_migrator', 'eduapp_tenancy_api', 'eduapp_access_api']) {
    const secret = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${secret}'`);
    const roleUrl = new URL(url);
    roleUrl.username = role;
    roleUrl.password = secret;
    credentials.set(role, roleUrl.href);
  }
  const migrator = await connect(credentials.get('eduapp_schema_migrator'));
  for (const apply of [applyTenantIsolation, applyAccessInvitations, applyAccessPolicy, applyTenantRegistry,
    applyOrganizationTree, applyScopedOrgManagement]) {
    await apply(migrator);
  }
  assert.equal(await applyScopedOrgManagement(migrator), false);
  const tx = (role) => {
    const pool = new pg.Pool({ connectionString: credentials.get(role), connectionTimeoutMillis: 3000, max: 4 });
    t.after(() => pool.end());
    return createTenantTransactions(pool);
  };
  return { admin, tenancy: tx('eduapp_tenancy_api'), access: tx('eduapp_access_api') };
}

test('scoped invitation and reparent authorization with native PostgreSQL', { timeout: 30_000 }, async (t) => {
  const { admin, tenancy, access: accessTx } = await setup(t);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  for (const tenantId of [tenantA, tenantB]) {
    await admin.query("INSERT INTO tenancy_organization.tenants (id,slug,status) VALUES ($1,$2,'active')",
      [tenantId, 'fixture-' + tenantId]);
  }
  const access = createAccessRepository({ transactions: accessTx, scopedInvitations: true });
  const permission = createAccessService({
    repository: createPostgresAccessRepository({ transactions: accessTx }),
    resolveMembership: access.resolveMembership,
  });
  const tree = createOrganizationTree({
    transactions: tenancy,
    authorize: ({ identity, tenantId, action, orgUnitId }) => permission.can(identity, { tenantId, action, orgUnitId }),
  });
  async function account() {
    const id = randomUUID();
    await admin.query("INSERT INTO identity_access.identities (id,login_normalized,status) VALUES ($1,$2,'active')",
      [id, id + '@example.test']);
    return id;
  }
  async function actor(tenantId, orgUnitId, actions) {
    const id = await account();
    const membershipId = randomUUID();
    const roleId = randomUUID();
    await admin.query(`
      INSERT INTO identity_access.memberships (tenant_id,id,identity_id,org_unit_id,status)
      VALUES ($1,$2,$3,$4,'active')
    `, [tenantId, membershipId, id, orgUnitId]);
    const rules = actions.map(action => ({ action, effect: 'allow', relationship: null, fields: [] }));
    await admin.query(`
      INSERT INTO identity_access.roles (tenant_id,id,name,version,rules) VALUES ($1,$2,$3,1,$4::jsonb)
    `, [tenantId, roleId, roleId, JSON.stringify(rules)]);
    await admin.query(`
      INSERT INTO identity_access.role_bindings (tenant_id,membership_id,role_id,scope_org_id) VALUES ($1,$2,$3,$4)
    `, [tenantId, membershipId, roleId, orgUnitId]);
    return { actor: id, identityId: id, tenantId, scope: tenantId, membershipId, sessionId: randomUUID() };
  }
  const orgOwnerActions = ['tenancy.org.read', 'tenancy.org.write', 'access.invitation.create'];
  const ownerA = await actor(tenantA, null, orgOwnerActions);
  const ownerB = await actor(tenantB, null, orgOwnerActions);
  const unit = (identity, { kind, parentId, code }) =>
    tree.create({ identity, body: { kind, parentId, code, name: 'Fixture ' + code, idempotencyKey: randomUUID() } });
  const parentA = await unit(ownerA, { kind: 'collection', parentId: null, code: 'parent-a' });
  const parentB = await unit(ownerA, { kind: 'collection', parentId: null, code: 'parent-b' });
  const child = await unit(ownerA, { kind: 'branch', parentId: parentA.orgUnitId, code: 'moving-branch' });
  const foreign = await unit(ownerB, { kind: 'collection', parentId: null, code: 'foreign-parent' });
  const aManager = await actor(tenantA, parentA.orgUnitId, ['access.invitation.create']);
  const bManager = await actor(tenantA, parentB.orgUnitId, ['access.invitation.create']);
  const childManager = await actor(tenantA, child.orgUnitId, ['access.invitation.create']);
  const inviteeId = await account();
  const wrongId = await account();
  const invitee = { actor: inviteeId, identityId: inviteeId, sessionId: randomUUID(), scope: 'identity-bootstrap' };
  const wrong = { actor: wrongId, identityId: wrongId, sessionId: randomUUID(), scope: 'identity-bootstrap' };
  const sent = [];
  let failNextDelivery = false;
  let allowMfa = true;
  const service = createPeopleService({
    access, people: {},
    authorize: createAccessAuthorize(permission), verifyOrgUnit: tree.verifyOrgUnit,
    findActiveIdentity: async ({ identityId }) => (await admin.query(
      "SELECT id FROM identity_access.identities WHERE id = $1 AND status = 'active'", [identityId],
    )).rows[0],
    requireRecentMfa: () => allowMfa,
    invitationKey: randomBytes(32),
    deliverInvitation: async (message) => {
      sent.push(message);
      if (!failNextDelivery) return true;
      failNextDelivery = false;
      return false;
    },
  });
  const gateway = createServer(createGateway({
    authenticate: header => ({ 'Bearer owner': ownerA, 'Bearer invited': invitee, 'Bearer other': wrong })[header],
    routes: createPeopleRoutes({ service, GatewayError, scopedInvitations: true }),
  }));
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => gateway.close(error => error ? reject(error) : resolve())));
  async function post(path, who, body) {
    const response = await fetch('http://127.0.0.1:' + gateway.address().port + '/v1' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + who },
      body: JSON.stringify(body),
    });
    return { status: response.status, ...(await response.json()) };
  }
  const issue = (identity, orgUnitId, extra = {}, requestKey) => service.createInvitation({
    identity, requestId: randomUUID(), requestKey, body: { identityId: inviteeId, orgUnitId, ...extra },
  });
  const redeem = (who, tenantId, token) => post('/invitations/accept', who, { tenantId, token });
  const moveChild = (identity, parentId, version, requestId) => tree.move({
    identity, orgUnitId: child.orgUnitId, ifMatch: '"' + version + '"', requestId, body: { parentId },
  });

  await t.test('exact scope and MFA constrain issuance with a bounded UTC expiry', async () => {
    assert.equal(await tree.verifyOrgUnit({ tenantId: tenantA, orgUnitId: child.orgUnitId }), true);
    assert.equal(await tree.verifyOrgUnit({ tenantId: tenantB, orgUnitId: child.orgUnitId }), false);
    allowMfa = false;
    await assert.rejects(issue(ownerA, child.orgUnitId), { message: 'FORBIDDEN' });
    allowMfa = true;
    await assert.rejects(issue(aManager, child.orgUnitId), { message: 'NOT_FOUND' });
    await assert.rejects(issue(ownerA, foreign.orgUnitId), { message: 'NOT_FOUND' });
    await assert.rejects(issue(ownerA, child.orgUnitId, { expiresInHours: 169 }), { message: 'VALIDATION_FAILED' });
    const response = await post('/invitations', 'owner', {
      identityId: inviteeId, orgUnitId: child.orgUnitId, expiresInHours: 1,
    });
    assert.equal(response.status, 202);
    assert.deepEqual(Object.keys(response.data).sort(), ['expiresAt', 'invitationId', 'status']);
    const { rows: [stored] } = await admin.query(`
      SELECT token_hash, extract(epoch FROM expires_at-created_at)::int AS lifetime
      FROM identity_access.invitations WHERE tenant_id = $1 AND id = $2
    `, [tenantA, response.data.invitationId]);
    assert.equal(stored.lifetime, 3600);
    const token = sent.at(-1).token;
    assert.deepEqual(stored.token_hash, createHash('sha256').update(token, 'ascii').digest());
    assert.equal((await redeem('other', tenantA, token)).status, 404);
    assert.equal((await redeem('invited', tenantB, token)).status, 404);
    const attempts = await Promise.all([redeem('invited', tenantA, token), redeem('invited', tenantA, token)]);
    assert.deepEqual(attempts.map(item => item.status).sort(), [200, 404]);
    const accepted = attempts.find(item => item.status === 200).data;
    assert.equal(accepted.orgUnitId, child.orgUnitId);
    assert.deepEqual(await access.resolveMembership({ tenantId: tenantA, identityId: inviteeId,
      membershipId: accepted.membershipId }), accepted);
    assert.equal((await admin.query(
      'SELECT 1 FROM identity_access.role_bindings WHERE tenant_id = $1 AND membership_id = $2',
      [tenantA, accepted.membershipId],
    )).rowCount, 0);
  });

  await t.test('durable retry preserves delivery identity, fails expired tokens and checks live Tenant', async () => {
    const requestKey = randomUUID();
    failNextDelivery = true;
    await assert.rejects(issue(ownerA, child.orgUnitId, {}, requestKey), { message: 'SERVICE_UNAVAILABLE' });
    const pending = sent.at(-1);
    assert.equal((await redeem('invited', tenantA, pending.token)).status, 404);
    const result = await issue(ownerA, child.orgUnitId, {}, requestKey);
    assert.equal(result.invitationId, pending.invitationId);
    assert.equal(sent.at(-1).token, pending.token);
    const deliveryCount = sent.length;
    assert.deepEqual(await issue(ownerA, child.orgUnitId, {}, requestKey), result);
    assert.equal(sent.length, deliveryCount);
    await assert.rejects(issue(ownerA, parentA.orgUnitId, {}, requestKey), { message: 'IDEMPOTENCY_CONFLICT' });
    await admin.query(`
      UPDATE identity_access.invitations SET created_at = statement_timestamp() - interval '49 hours',
        expires_at = statement_timestamp() - interval '1 hour' WHERE tenant_id = $1 AND id = $2
    `, [tenantA, result.invitationId]);
    assert.equal((await redeem('invited', tenantA, pending.token)).status, 404);
    await issue(ownerB, null);
    const foreignToken = sent.at(-1).token;
    await admin.query("UPDATE tenancy_organization.tenants SET status = 'suspended' WHERE id = $1", [tenantB]);
    assert.equal(await tree.verifyOrgUnit({ tenantId: tenantB, orgUnitId: foreign.orgUnitId }), false);
    assert.equal((await redeem('invited', tenantB, foreignToken)).status, 404);
  });

  await t.test('reparenting appends history and neither parent inherits permissions', async () => {
    const exactPermission = (identity) => permission.can(identity, {
      action: 'access.invitation.create', tenantId: tenantA, orgUnitId: child.orgUnitId,
    });
    assert.equal(await exactPermission(aManager), false);
    assert.equal(await exactPermission(bManager), false);
    assert.equal(await exactPermission(childManager), true);
    await assert.rejects(moveChild(aManager, parentB.orgUnitId, 1), { message: 'FORBIDDEN' });
    await assert.rejects(moveChild(ownerA, foreign.orgUnitId, 1), { message: 'ORG_PARENT_NOT_FOUND' });
    const requestId = randomUUID();
    const moved = await moveChild(ownerA, parentB.orgUnitId, 1, requestId);
    assert.equal(moved.parentId, parentB.orgUnitId);
    assert.equal(moved.version, 2);
    await assert.rejects(moveChild(ownerA, parentA.orgUnitId, 1), { message: 'PRECONDITION_FAILED' });
    assert.deepEqual(await moveChild(ownerA, parentB.orgUnitId, 2), moved);
    assert.equal(await exactPermission(aManager), false);
    assert.equal(await exactPermission(bManager), false);
    assert.equal(await exactPermission(childManager), true);
    await assert.rejects(issue(bManager, child.orgUnitId), { message: 'NOT_FOUND' });
    assert.equal((await issue(childManager, child.orgUnitId)).status, 'queued');
    const history = (await admin.query(`
      SELECT prior_parent_id,parent_id,prior_version,version,actor_id,request_id
      FROM tenancy_organization.org_unit_move_history WHERE tenant_id = $1 AND org_unit_id = $2
    `, [tenantA, child.orgUnitId])).rows;
    assert.deepEqual(history, [{ prior_parent_id: parentA.orgUnitId, parent_id: parentB.orgUnitId,
      prior_version: 1, version: 2, actor_id: ownerA.actor, request_id: requestId }]);
    const inForeignScope = await tenancy.run(tenantB, db => db.query(
      'SELECT * FROM tenancy_organization.org_unit_move_history WHERE org_unit_id = $1', [child.orgUnitId],
    ));
    assert.equal(inForeignScope.rowCount, 0);
    await assert.rejects(tenancy.run(tenantA, db => db.query(
      'DELETE FROM tenancy_organization.org_unit_move_history WHERE org_unit_id = $1', [child.orgUnitId],
    )), { code: '42501' });
  });
});

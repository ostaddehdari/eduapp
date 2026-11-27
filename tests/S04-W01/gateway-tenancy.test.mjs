import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import pg from 'pg';
import { createGatewayRuntime } from '../../apps/api-gateway/src/runtime.mjs';
import { hashPassword } from '../../apps/identity-service/src/auth/crypto.mjs';
import {
  applyAccessInvitations, applyAccessPolicy, applyIamMfa, applyIamSessions, applyOrganizationTree,
  applySecurityAudit, applyTenantIsolation, applyTenantRegistry, runSqlBootstrap,
} from '../../packages/data/src/migrate.mjs';

const migrations = [
  applyTenantIsolation, applyIamSessions, applyAccessInvitations, applyAccessPolicy, applyIamMfa,
  applySecurityAudit, applyTenantRegistry, applyOrganizationTree,
];

async function fixture(t) {
  const configured = process.env.EDUAPP_S04_REGISTRY_PG_ADMIN_URL;
  assert(configured, 'Set EDUAPP_S04_REGISTRY_PG_ADMIN_URL for disposable PostgreSQL 17');
  const url = new URL(configured);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s04_registry_test');
  assert.equal(url.search + url.hash, '');
  url.pathname = '/postgres';
  const provisioner = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  await provisioner.connect();
  try {
    const exists = await provisioner.query("SELECT 1 FROM pg_database WHERE datname = 'eduapp_s04_gateway_test'");
    if (!exists.rowCount) await provisioner.query('CREATE DATABASE eduapp_s04_gateway_test');
  } finally {
    await provisioner.end();
  }
  url.pathname = '/eduapp_s04_gateway_test';
  const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  await admin.connect();
  t.after(() => admin.end());
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);

  async function credentials(role) {
    const password = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    const scoped = new URL(url);
    scoped.username = role;
    scoped.password = password;
    return scoped.href;
  }
  const migrator = new pg.Client({ connectionString: await credentials('eduapp_schema_migrator') });
  await migrator.connect();
  try {
    for (const apply of migrations) await apply(migrator);
  } finally {
    await migrator.end();
  }
  const pools = {};
  for (const [name, role] of Object.entries({
    iamPool: 'eduapp_iam_api', peoplePool: 'eduapp_people_api', accessPool: 'eduapp_access_api',
    tenancyPool: 'eduapp_tenancy_api',
  })) {
    const pool = new pg.Pool({ connectionString: await credentials(role), max: 2, connectionTimeoutMillis: 3000 });
    t.after(() => pool.end());
    pools[name] = pool;
  }
  return { admin, pools };
}

test('a provisioned owner can use the organization tree through IAM and loses scope on suspension', {
  timeout: 45_000,
}, async t => {
  const { admin, pools: { tenancyPool, ...identityPools } } = await fixture(t);
  async function account() {
    const id = randomUUID();
    const login = id + '@test.invalid';
    const password = randomBytes(18).toString('hex');
    await admin.query(`
      INSERT INTO identity_access.identities (id, login_normalized, status, password_hash)
      VALUES ($1, $2, 'active', $3)
    `, [id, login, await hashPassword(password)]);
    return { id, login, password };
  }
  const platform = await account();
  const owner = await account();
  const { gateway } = createGatewayRuntime({
    identity: {
      ...identityPools, accessSigningKey: randomBytes(32), otpPepper: randomBytes(32), accessPolicy: {},
      deliverOtp: async () => {},
    },
    tenancy: {
      pool: tenancyPool,
      authorizeProvisioning: async ({ identity }) => identity.actor === platform.id ? { kind: 'platform_admin' } : null,
      authorizeStatusChange: async ({ identity }) => identity.actor === platform.id,
    },
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const base = 'http://127.0.0.1:' + gateway.address().port + '/v1';
  async function request(path, status, { method = 'GET', body, token, headers } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    assert.equal(response.status, status, result.error?.code);
    return { ...result, etag: response.headers.get('etag') };
  }
  const login = ({ login, password }, selection = {}) => request('/auth/login', 200, {
    method: 'POST', body: { login, password, ...selection },
  });
  const adminLogin = await login(platform);
  const ownerLogin = await login(owner);
  const platformToken = adminLogin.data.accessToken;
  const candidate = () => ({
    slug: 'fixture-' + randomUUID(), displayName: 'Synthetic school customer',
    ownerIdentityId: owner.id, legalEntity: { name: 'Synthetic institute', countryCode: 'IR', registrationNumber: randomUUID() },
    trialDays: 7,
  });
  const provision = (body, key, token = platformToken, status = 201) => request('/tenants', status, {
    method: 'POST', body, token, headers: { 'Idempotency-Key': key },
  });
  const firstBody = candidate();
  const firstKey = randomUUID();
  await provision(firstBody, firstKey, ownerLogin.data.accessToken, 403);
  const first = (await provision(firstBody, firstKey)).data;
  const second = (await provision(candidate(), randomUUID())).data;
  assert.notEqual(first.id, second.id);
  assert.equal((await provision(firstBody, firstKey)).data.id, first.id);
  await provision({ ...firstBody, displayName: 'Different fixture' }, firstKey, platformToken, 409);
  assert.equal(first.ownerIdentityId, owner.id);
  assert.equal(first.status, 'active');
  assert(first.trialEndsAt);

  const select = async tenant => (await login(owner, {
    tenantId: tenant.id, membershipId: tenant.ownerMembershipId,
  })).data.accessToken;
  const firstToken = await select(first);
  const secondToken = await select(second);
  assert.deepEqual((await request('/tenants', 200, { token: firstToken })).data.map(x => x.id), [first.id]);
  await request('/tenants/' + second.id, 404, { token: firstToken, headers: { 'X-Tenant-Id': second.id } });
  const createUnit = (kind, code, parentId, token, status = 201) => request('/org-units', status, {
    method: 'POST', token, body: { kind, code, name: code, parentId, idempotencyKey: randomUUID() },
  });
  const root = (await createUnit('collection', 'school-group', null, firstToken)).data;
  const branch = (await createUnit('branch', 'north', root.orgUnitId, firstToken)).data;
  const school = (await createUnit('school', 'school-a', branch.orgUnitId, firstToken)).data;
  const standalone = (await createUnit('school', 'school-b', null, secondToken)).data;
  const foreign = await createUnit('school', 'rejected', branch.orgUnitId, secondToken, 404);
  assert.equal(foreign.error.code, 'ORG_PARENT_NOT_FOUND');
  const firstPage = await request('/org-units/tree?limit=1', 200, { token: firstToken });
  assert.equal(firstPage.data.length, 1);
  assert(firstPage.meta.nextCursor);
  await request('/org-units/tree?limit=1&cursor=' + firstPage.meta.nextCursor, 400, { token: secondToken });
  assert.deepEqual((await request('/org-units/tree', 200, { token: secondToken })).data.map(x => x.orgUnitId),
    [standalone.orgUnitId]);
  const movePath = '/org-units/' + school.orgUnitId + '/move';
  const move = (status, headers) => request(movePath, status, {
    method: 'POST', token: firstToken, body: { parentId: root.orgUnitId }, headers,
  });
  await move(428);
  const moved = await move(200, { 'If-Match': '"1"' });
  assert.equal(moved.etag, '"2"');
  assert.equal(moved.data.parentId, root.orgUnitId);
  await move(412, { 'If-Match': '"1"' });

  const statusPath = '/tenants/' + first.id + '/status';
  const setStatus = (status, token, state, expectedVersion) => request(statusPath, status, {
    method: 'PATCH', token, body: { status: state, expectedVersion },
  });
  await setStatus(403, firstToken, 'suspended', 1);
  const suspended = await setStatus(200, platformToken, 'suspended', 1);
  assert.equal(suspended.data.status, 'suspended');
  await request('/org-units', 401, { token: firstToken });
  await request('/org-units', 200, { token: secondToken });
  const reactivated = await setStatus(200, platformToken, 'active', 2);
  assert.equal(reactivated.data.status, 'active');
  const restored = await select(first);
  assert.equal((await request('/org-units', 200, { token: restored })).data.length, 3);
});

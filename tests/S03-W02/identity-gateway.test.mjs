import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import pg from 'pg';
import { createGatewayRuntime } from '../../apps/api-gateway/src/runtime.mjs';
import { hashPassword } from '../../apps/identity-service/src/auth/crypto.mjs';
import {
  applyAccessInvitations, applyIamSessions, applyTenantIsolation, runSqlBootstrap,
} from '../../packages/data/src/migrate.mjs';

const database = 'eduapp_s03_identity_gateway_test';

async function fixture(t) {
  const config = process.env.EDUAPP_S03_W02_PG_ADMIN_URL;
  assert(config, 'Set EDUAPP_S03_W02_PG_ADMIN_URL for the isolated identity test');
  const url = new URL(config);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s03_w02_test');
  assert.equal(url.search + url.hash, '');
  url.pathname = '/postgres';
  const provisioning = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  await provisioning.connect();
  try {
    const exists = await provisioning.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!exists.rowCount) await provisioning.query('CREATE DATABASE eduapp_s03_identity_gateway_test');
  } finally {
    await provisioning.end();
  }

  url.pathname = '/' + database;
  const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  await admin.connect();
  t.after(() => admin.end());
  await runSqlBootstrap(admin);

  async function connectAs(role) {
    const password = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    const credentials = new URL(url);
    credentials.username = role;
    credentials.password = password;
    return credentials.href;
  }

  const migrator = new pg.Client({ connectionString: await connectAs('eduapp_schema_migrator') });
  await migrator.connect();
  try {
    await applyTenantIsolation(migrator);
    await applyIamSessions(migrator);
    await applyAccessInvitations(migrator);
  } finally {
    await migrator.end();
  }
  const roles = ['eduapp_iam_api', 'eduapp_people_api', 'eduapp_access_api'];
  const pools = [];
  for (const role of roles) {
    const pool = new pg.Pool({ connectionString: await connectAs(role), max: 2, connectionTimeoutMillis: 3000 });
    t.after(() => pool.end());
    pools.push(pool);
  }
  return { admin, pools };
}

test('the composed Gateway serves only the active membership scope after refresh', { timeout: 45000 }, async t => {
  const { admin, pools: [iamPool, peoplePool, accessPool] } = await fixture(t);
  const identityId = randomUUID();
  const nonce = randomBytes(12).toString('hex');
  const login = nonce + '@test.invalid';
  const password = randomBytes(24).toString('hex');
  await admin.query(
    'INSERT INTO identity_access.identities (id, login_normalized, status, password_hash) VALUES ($1,$2,$3,$4)',
    [identityId, login, 'active', await hashPassword(password)],
  );
  const schools = ['First fixture', 'Second fixture'].map(label => ({
    label, tenantId: randomUUID(), membershipId: randomUUID(), profileId: randomUUID(),
  }));
  for (const school of schools) {
    await admin.query('INSERT INTO tenancy_organization.tenants (id, slug, status) VALUES ($1,$2,$3)',
      [school.tenantId, school.tenantId, 'active']);
    await admin.query('INSERT INTO identity_access.memberships (id, tenant_id, identity_id, status) VALUES ($1,$2,$3,$4)',
      [school.membershipId, school.tenantId, identityId, 'active']);
    await admin.query('INSERT INTO people_fields.persons (id, tenant_id, display_name) VALUES ($1,$2,$3)',
      [school.profileId, school.tenantId, school.label]);
  }

  const { gateway } = createGatewayRuntime({
    identity: {
      iamPool, peoplePool, accessPool, accessSigningKey: randomBytes(32), otpPepper: randomBytes(32),
      deliverOtp: async () => {},
      authorize: ({ actor, action }) => actor === identityId && action === 'people.user.read',
    },
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const base = 'http://127.0.0.1:' + gateway.address().port + '/v1';

  const send = (path, { method = 'GET', token, body } = {}) => fetch(base + path, {
    method,
    headers: {
      ...(token === undefined ? {} : { Authorization: 'Bearer ' + token }),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  async function data(response, status = 200) {
    assert.equal(response.status, status);
    return (await response.json()).data;
  }
  const [first, second] = schools;
  const session = await data(await send('/auth/login', { method: 'POST', body: {
    login, password, tenantId: first.tenantId, membershipId: first.membershipId,
  } }));
  assert.equal(session.tenantId, first.tenantId);
  const firstPage = await data(await send('/users', { token: session.accessToken }));
  assert.deepEqual(firstPage.map(item => item.displayName), [first.label]);
  assert.equal((await send('/users/' + second.profileId, { token: session.accessToken })).status, 404);
  assert.equal((await send('/users', { method: 'POST', token: session.accessToken, body: { displayName: 'Denied' } })).status, 403);

  const rotated = await data(await send('/auth/refresh', { method: 'POST', token: session.refreshToken, body: {
    tenantId: second.tenantId, membershipId: second.membershipId,
  } }));
  assert.equal(rotated.tenantId, second.tenantId);
  assert.equal((await send('/users', { token: session.accessToken })).status, 401);
  const secondPage = await data(await send('/users', { token: rotated.accessToken }));
  assert.deepEqual(secondPage.map(item => item.displayName), [second.label]);
  assert.equal((await send('/users/' + first.profileId, { token: rotated.accessToken })).status, 404);
});

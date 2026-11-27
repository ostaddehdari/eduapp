import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import pg from 'pg';
import { createGatewayRuntime } from '../../apps/api-gateway/src/runtime.mjs';
import { hashPassword } from '../../apps/identity-service/src/auth/crypto.mjs';
import {
  applyAccessInvitations, applyAccessPolicy, applyIamMfa, applyIamSessions, applyTenantIsolation, runSqlBootstrap,
} from '../../packages/data/src/migrate.mjs';

const testDatabase = 'eduapp_s03_secure_gateway_test';
const migrations = [applyTenantIsolation, applyIamSessions, applyAccessInvitations, applyAccessPolicy, applyIamMfa];

function fixtureCode(secret, instant) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  assert.match(secret, /^[A-Z2-7]+$/);
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('');
  const seed = Buffer.from(bits.match(/[01]{8}/g).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(instant / 30_000)));
  const digest = createHmac('sha1', seed).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function fixture(t) {
  const configured = process.env.EDUAPP_MFA_PG_ADMIN_URL;
  assert(configured, 'Set EDUAPP_MFA_PG_ADMIN_URL for the local identity fixture');
  const url = new URL(configured);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s03_mfa_test');
  assert.equal(url.search + url.hash, '');
  url.pathname = '/postgres';
  const installer = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  await installer.connect();
  try {
    const present = await installer.query('SELECT 1 FROM pg_database WHERE datname=$1', [testDatabase]);
    if (!present.rowCount) await installer.query('CREATE DATABASE eduapp_s03_secure_gateway_test');
  } finally {
    await installer.end();
  }
  url.pathname = '/' + testDatabase;
  const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  await admin.connect();
  t.after(() => admin.end());
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
  })) {
    const pool = new pg.Pool({ connectionString: await credentials(role), max: 2, connectionTimeoutMillis: 3000 });
    t.after(() => pool.end());
    pools[name] = pool;
  }
  return { admin, pools };
}

test('role and membership writes require live permission and recent MFA in the composed Gateway', { timeout: 45000 }, async t => {
  const { admin, pools } = await fixture(t);
  const actor = randomUUID();
  const login = actor + '@test.invalid';
  const password = randomBytes(24).toString('hex');
  await admin.query('INSERT INTO identity_access.identities (id,login_normalized,status,password_hash) VALUES ($1,$2,$3,$4)',
    [actor, login, 'active', await hashPassword(password)]);
  const rules = [
    { action: 'access.role.read', effect: 'allow' },
    { action: 'access.role.write', effect: 'allow' },
    { action: 'access.membership.create', effect: 'allow' },
    { action: 'people.user.read', effect: 'allow', fields: ['id', 'displayName'] },
  ];
  const schools = Array.from({ length: 2 }, () => ({ tenantId: randomUUID(), membershipId: randomUUID(), roleId: randomUUID() }));
  for (const school of schools) {
    await admin.query('INSERT INTO tenancy_organization.tenants (id,slug,status) VALUES ($1,$2,$3)', [school.tenantId, school.tenantId, 'active']);
    await admin.query('INSERT INTO identity_access.memberships (id,tenant_id,identity_id,status) VALUES ($1,$2,$3,$4)',
      [school.membershipId, school.tenantId, actor, 'active']);
    await admin.query('INSERT INTO identity_access.roles (id,tenant_id,name,version,rules,builtin) VALUES ($1,$2,$3,1,$4::jsonb,true)',
      [school.roleId, school.tenantId, 'Fixture policy', JSON.stringify(rules)]);
    await admin.query('INSERT INTO identity_access.role_bindings (tenant_id,membership_id,role_id) VALUES ($1,$2,$3)',
      [school.tenantId, school.membershipId, school.roleId]);
  }
  let now = Date.now();
  const { gateway } = createGatewayRuntime({ identity: {
    ...pools, accessSigningKey: randomBytes(32), otpPepper: randomBytes(32), mfaEncryptionKey: randomBytes(32),
    accessPolicy: {}, deliverOtp: async () => {}, now: () => now,
  } });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const base = 'http://127.0.0.1:' + gateway.address().port + '/v1';
  const post = (path, body, token) => fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  });
  async function data(response, expectedCode = 200) {
    assert.equal(response.status, expectedCode);
    return (await response.json()).data;
  }
  const [first, second] = schools;
  const session = await data(await post('/auth/login', { login, password, tenantId: first.tenantId, membershipId: first.membershipId }));
  const role = { name: 'Readers', rules: [{ action: 'people.user.read', effect: 'allow', fields: ['id'] }] };
  assert.equal((await post('/roles', role, session.accessToken)).status, 403);
  assert.equal((await post('/memberships', { identityId: actor }, session.accessToken)).status, 403);

  const enrollment = await data(await post('/auth/mfa/enroll', { password }, session.accessToken));
  await data(await post('/auth/mfa/enroll/confirm', {
    challengeId: enrollment.challengeId, code: fixtureCode(enrollment.secret, now),
  }, session.accessToken));
  now += 30_000;
  await data(await post('/auth/mfa/step-up', { code: fixtureCode(enrollment.secret, now) }, session.accessToken));
  await data(await post('/roles', role, session.accessToken), 201);
  const membership = await data(await post('/memberships', { identityId: actor }, session.accessToken), 201);
  assert.equal(membership.membershipId, first.membershipId);
  assert.equal((await post('/role-assignments', { roleId: first.roleId, membershipId: first.membershipId }, session.accessToken)).status, 403);

  const moved = await data(await post('/auth/refresh', { tenantId: second.tenantId, membershipId: second.membershipId }, session.refreshToken));
  assert.equal(moved.tenantId, second.tenantId);
  assert.equal((await post('/roles', role, session.accessToken)).status, 401);
  assert.equal((await post('/roles', role, moved.accessToken)).status, 403);
  assert.equal((await post('/memberships', { identityId: actor }, moved.accessToken)).status, 403);
});

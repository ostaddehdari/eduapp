import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createGateway, GatewayError } from '../../apps/api-gateway/src/gateway.mjs';
import { digest, hashPassword } from '../../apps/identity-service/src/auth/crypto.mjs';
import { createAuthGatewayOptions } from '../../apps/identity-service/src/auth/routes.mjs';
import { createAuthService } from '../../apps/identity-service/src/auth/service.mjs';
import { createMfaRoutes } from '../../apps/identity-service/src/mfa/routes.mjs';
import { createMfaService } from '../../apps/identity-service/src/mfa/service.mjs';
import { applyIamMfa, applyIamSessions, applyTenantIsolation, runSqlBootstrap } from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';

const fixtureName = 'eduapp_s03_mfa_test';
const password = 'synthetic MFA fixture password';
const minute = 60_000;

function fixtureCode(secret, instant) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const binary = [...secret].map((character) => alphabet.indexOf(character).toString(2).padStart(5, '0')).join('');
  const seed = Buffer.from(binary.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(instant / 30_000)));
  const mac = createHmac('sha1', seed).update(counter).digest();
  const offset = mac.at(-1) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function wrongCode(secret, instant) {
  const valid = new Set([-30_000, 0, 30_000].map((delta) => fixtureCode(secret, instant + delta)));
  return ['000000', '000001', '000002', '000003'].find((code) => !valid.has(code));
}

async function makeFixture(t) {
  assert(process.env.EDUAPP_MFA_PG_ADMIN_URL, 'Set EDUAPP_MFA_PG_ADMIN_URL for disposable PostgreSQL 17');
  const url = new URL(process.env.EDUAPP_MFA_PG_ADMIN_URL);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/' + fixtureName);
  assert.equal(url.search, '');
  const modulePath = process.env.EDUAPP_PG_MODULE;
  const driver = await import(modulePath ? pathToFileURL(modulePath).href : 'pg');
  const { Client, Pool } = driver.default ?? driver;
  const connect = async (connectionString) => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 3000 });
    await client.connect();
    t.after(() => client.end());
    return client;
  };
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  const maintenance = await connect(maintenanceUrl.href);
  const existing = await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [fixtureName]);
  if (!existing.rowCount) await maintenance.query('CREATE DATABASE ' + fixtureName);
  const admin = await connect(url.href);
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);
  const roleUrls = new Map();
  for (const role of ['eduapp_iam_api', 'eduapp_access_api', 'eduapp_schema_migrator']) {
    const secret = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${secret}'`);
    const credentials = new URL(url);
    credentials.username = role;
    credentials.password = secret;
    roleUrls.set(role, credentials.href);
  }
  const migration = await connect(roleUrls.get('eduapp_schema_migrator'));
  await applyTenantIsolation(migration);
  await applyIamSessions(migration);
  await applyIamMfa(migration);
  assert.equal(await applyIamMfa(migration), false);
  const makePool = (role) => {
    const pool = new Pool({ connectionString: roleUrls.get(role), max: 4, connectionTimeoutMillis: 3000 });
    t.after(() => pool.end());
    return pool;
  };
  return { admin, iam: makePool('eduapp_iam_api'), access: makePool('eduapp_access_api') };
}

test('MFA and recovery over Gateway and native PostgreSQL', { timeout: 35_000 }, async (t) => {
  const { admin, iam, access } = await makeFixture(t);
  const identityId = randomUUID();
  const login = identityId + '@example.test';
  const scopeA = { tenantId: randomUUID(), membershipId: randomUUID() };
  const scopeB = { tenantId: randomUUID(), membershipId: randomUUID() };
  await admin.query(
    "INSERT INTO identity_access.identities (id, login_normalized, status, password_hash) VALUES ($1,$2,'active',$3)",
    [identityId, login, await hashPassword(password)],
  );
  for (const scope of [scopeA, scopeB]) {
    await admin.query(`
      INSERT INTO identity_access.memberships (tenant_id,id,identity_id,status) VALUES ($1,$2,$3,'active')
    `, [scope.tenantId, scope.membershipId, identityId]);
  }
  let instant = Date.now();
  const otpPepper = randomBytes(32);
  const now = () => instant;
  const membership = createTenantTransactions(access);
  const auth = createAuthService({
    pool: iam, accessSigningKey: randomBytes(32), otpPepper, now,
    deliverOtp: async () => {},
    resolveMembership: ({ tenantId, membershipId, identityId }) => membership.run(tenantId, async (db) => {
      const { rows } = await db.query(`
        SELECT tenant_id AS "tenantId", id AS "membershipId" FROM identity_access.memberships
        WHERE identity_id = $1 AND id = $2 AND status = 'active'
      `, [identityId, membershipId]);
      return rows[0] ?? null;
    }),
  });
  const mfa = createMfaService({ pool: iam, encryptionKey: randomBytes(32), otpPepper, now });
  const options = createAuthGatewayOptions(auth, { GatewayError });
  const gateway = createServer(createGateway({
    authenticate: options.authenticate,
    routes: [...options.routes, ...createMfaRoutes({ mfa, GatewayError }), {
      id: 'createRole', budget: { max: 20, windowSeconds: 60 },
      authorize: ({ identity }) => mfa.isFresh(identity),
      handle: () => ({ status: 201, data: { changed: true } }),
    }],
  }));
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve())));
  const base = 'http://127.0.0.1:' + gateway.address().port + '/v1';
  async function request(path, { bearer, body, method = 'POST' } = {}) {
    const headers = {};
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path, { headers, method, body: body && JSON.stringify(body) });
    return { status: response.status, headers: response.headers,
      ...(response.status === 204 ? {} : await response.json()) };
  }
  const post = (path, bearer, body) => request(path, { bearer, body });
  const loginTo = async (scope) => {
    const result = await post('/auth/login', undefined, { login, password, ...scope });
    assert.equal(result.status, 200);
    return result.data;
  };
  const action = (token) => post('/roles', token, { name: 'fixture-role' });
  const mfaPost = (name, token, body) => post('/auth/mfa/' + name, token, body);
  const bearerA = await loginTo(scopeA);
  const bearerB = await loginTo(scopeB);
  let enrolled;
  let codes;
  let recovered;

  await t.test('requires password and scoped proof, and stores no raw factors or codes', async () => {
    assert.equal((await action(bearerA.accessToken)).status, 404);
    assert.equal((await mfaPost('enroll', bearerA.accessToken, { password: 'wrong' })).status, 422);
    const response = await mfaPost('enroll', bearerA.accessToken, { password });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    enrolled = response.data;
    assert.match(enrolled.secret, /^[A-Z2-7]{32}$/);
    assert(enrolled.otpauthUri.startsWith('otpauth://totp/'));
    const proposed = { challengeId: enrolled.challengeId, code: fixtureCode(enrolled.secret, instant) };
    assert.equal((await mfaPost('enroll/confirm', bearerB.accessToken, proposed)).status, 422);
    assert.equal((await mfaPost('enroll/confirm', bearerA.accessToken,
      { ...proposed, code: wrongCode(enrolled.secret, instant) })).status, 422);
    const accepted = await mfaPost('enroll/confirm', bearerA.accessToken, proposed);
    assert.equal(accepted.status, 200);
    codes = accepted.data.recoveryCodes;
    assert.equal(new Set(codes).size, 8);
    assert.equal((await mfaPost('enroll/confirm', bearerA.accessToken, proposed)).status, 422);
    assert.equal((await action(bearerA.accessToken)).status, 404);
    const factor = (await iam.query('SELECT encrypted_seed FROM identity_access.mfa_factors WHERE identity_id = $1',
      [identityId])).rows[0];
    assert.match(factor.encrypted_seed, /^v1\./);
    assert(!factor.encrypted_seed.includes(enrolled.secret));
    const stored = await iam.query('SELECT digest FROM identity_access.mfa_recovery_codes WHERE identity_id = $1',
      [identityId]);
    assert.deepEqual(stored.rows.map((row) => row.digest).sort(), codes.map(digest).sort());
    await assert.rejects(access.query('SELECT identity_id FROM identity_access.mfa_factors'), { code: '42501' });
  });

  await t.test('fresh proof permits only the authenticated scope and rejects replay and stale revisions', async () => {
    instant += 30_000;
    const proof = { code: fixtureCode(enrolled.secret, instant) };
    assert.equal((await mfaPost('step-up', bearerA.accessToken, proof)).status, 200);
    assert.equal((await action(bearerA.accessToken)).status, 201);
    assert.equal((await action(bearerB.accessToken)).status, 404);
    assert.equal((await mfaPost('step-up', bearerB.accessToken, proof)).status, 422);
    const original = await auth.authenticate(bearerA.accessToken);
    assert.equal(await mfa.isFresh({ ...original, ...scopeB }), false);
    const switched = await post('/auth/refresh', bearerA.refreshToken, scopeB);
    assert.equal(switched.status, 200);
    assert.equal(await mfa.isFresh(original), false);
    assert.equal((await action(switched.data.accessToken)).status, 404);
    instant += 30_000;
    assert.equal((await mfaPost('step-up', bearerB.accessToken, { code: fixtureCode(enrolled.secret, instant) })).status, 200);
    assert.equal((await action(bearerB.accessToken)).status, 201);
    instant += 5 * minute;
    assert.equal((await action(bearerB.accessToken)).status, 404);
  });

  await t.test('recovery code and capability are single-use, expiring and scoped to one revision', async () => {
    const fresh = await loginTo(scopeA);
    const initiate = (bearer, recoveryCode) => mfaPost('recovery', bearer, { password, recoveryCode });
    const expires = await initiate(fresh.accessToken, codes[0]);
    assert.equal(expires.status, 200);
    assert.equal((await initiate(fresh.accessToken, codes[0])).status, 422);
    instant += 10 * minute;
    assert.equal((await mfaPost('recovery/confirm', fresh.accessToken,
      { recoveryToken: expires.data.recoveryToken, code: fixtureCode(expires.data.secret, instant) })).status, 422);

    const elsewhere = await loginTo(scopeB);
    const issue = await initiate(fresh.accessToken, codes[1]);
    assert.equal(issue.status, 200);
    const ticket = issue.data.recoveryToken;
    const confirm = { recoveryToken: ticket, code: fixtureCode(issue.data.secret, instant) };
    assert.equal((await request('/me/sessions', { method: 'GET', bearer: ticket })).status, 401);
    assert.equal((await post('/auth/refresh', ticket)).status, 401);
    assert.equal((await mfaPost('recovery/confirm', elsewhere.accessToken, confirm)).status, 422);
    assert.equal((await mfaPost('recovery/confirm', undefined, confirm)).status, 401);
    const accepted = await mfaPost('recovery/confirm', fresh.accessToken, confirm);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.signInRequired, true);
    assert.equal(accepted.data.recoveryCodes.length, 8);
    recovered = issue.data.secret;
    assert.equal((await mfaPost('recovery/confirm', fresh.accessToken, confirm)).status, 401);
    assert.equal((await request('/me/sessions', { method: 'GET', bearer: elsewhere.accessToken })).status, 401);
    assert.equal((await post('/auth/refresh', elsewhere.refreshToken)).status, 401);
    const loggedIn = await loginTo(scopeA);
    assert.equal((await initiate(loggedIn.accessToken, codes[2])).status, 422);
    assert.equal((await action(loggedIn.accessToken)).status, 404);
    instant += 30_000;
    assert.equal((await mfaPost('step-up', loggedIn.accessToken, { code: fixtureCode(recovered, instant) })).status, 200);
    assert.equal((await action(loggedIn.accessToken)).status, 201);
  });

  await t.test('writes only the verified scope and credential-free facts to append-only audit', async () => {
    const facts = (await iam.query(`
      SELECT event_type, tenant_id, membership_id FROM identity_access.mfa_audit_facts
      WHERE identity_id = $1 ORDER BY occurred_at
    `, [identityId])).rows;
    assert.deepEqual(new Set(facts.map((fact) => fact.event_type)), new Set([
      'identity.mfa_enrolled.v1', 'identity.mfa_step_up.v1',
      'identity.mfa_recovery_started.v1', 'identity.mfa_recovered.v1',
    ]));
    assert(facts.every((fact) => [scopeA, scopeB].some((scope) =>
      fact.tenant_id === scope.tenantId && fact.membership_id === scope.membershipId)));
    assert(!JSON.stringify(facts).includes(recovered));
    await assert.rejects(iam.query('DELETE FROM identity_access.mfa_audit_facts WHERE identity_id = $1', [identityId]),
      { code: '42501' });
    const revocations = (await iam.query(`
      SELECT reason FROM identity_access.session_revocations WHERE session_id = ANY($1)
    `, [[bearerA.sessionId, bearerB.sessionId]])).rows;
    assert.deepEqual(revocations, [{ reason: 'mfa_recovery' }, { reason: 'mfa_recovery' }]);
  });
});

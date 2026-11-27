import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createGateway, GatewayError } from '../../apps/api-gateway/src/gateway.mjs';
import { digest, hashPassword } from '../../apps/identity-service/src/auth/crypto.mjs';
import { createAuthGatewayOptions } from '../../apps/identity-service/src/auth/routes.mjs';
import { createAuthService } from '../../apps/identity-service/src/auth/service.mjs';
import { applyIamSessions, applyTenantIsolation, runSqlBootstrap } from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';

const adminUrl = process.env.EDUAPP_AUTH_PG_ADMIN_URL;
const fixtureName = 'eduapp_s03_auth_test';
const password = 'synthetic authentication fixture';
const minute = 60_000;

async function acquireFixture(t) {
  assert(adminUrl, 'Set EDUAPP_AUTH_PG_ADMIN_URL for a disposable PostgreSQL 17 fixture');
  const url = new URL(adminUrl);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/' + fixtureName);
  assert.equal(url.search, '');
  const modulePath = process.env.EDUAPP_PG_MODULE;
  const driver = await import(modulePath ? pathToFileURL(modulePath).href : 'pg');
  const { Client, Pool } = driver.default ?? driver;
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  const connect = async (connectionString) => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 3000 });
    await client.connect();
    t.after(() => client.end());
    return client;
  };
  const maintenance = await connect(maintenanceUrl.href);
  const { rowCount } = await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [fixtureName]);
  if (!rowCount) await maintenance.query('CREATE DATABASE ' + fixtureName);
  const admin = await connect(url.href);
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
  assert.equal(await applyIamSessions(migration), false);
  const createPool = (role) => {
    const pool = new Pool({ connectionString: roleUrls.get(role), max: 3, connectionTimeoutMillis: 3000 });
    t.after(() => pool.end());
    return pool;
  };
  return { admin, iam: createPool('eduapp_iam_api'), access: createPool('eduapp_access_api') };
}

test('Gateway authentication and sessions with real PostgreSQL', { timeout: 35_000 }, async (t) => {
  const { admin, iam, access } = await acquireFixture(t);
  const identityId = randomUUID();
  const login = identityId + '@example.test';
  const roleA = { tenantId: randomUUID(), membershipId: randomUUID(), orgUnitId: randomUUID() };
  const roleB = { tenantId: randomUUID(), membershipId: randomUUID(), orgUnitId: randomUUID() };
  const contextMissing = { tenantId: randomUUID(), membershipId: randomUUID() };
  await admin.query(
    "INSERT INTO identity_access.identities (id, login_normalized, status, password_hash) VALUES ($1,$2,'active',$3)",
    [identityId, login, await hashPassword(password)],
  );
  for (const scope of [roleA, roleB]) {
    await admin.query(`
      INSERT INTO identity_access.memberships (tenant_id, id, identity_id, org_unit_id, status)
      VALUES ($1,$2,$3,$4,'active')
    `, [scope.tenantId, scope.membershipId, identityId, scope.orgUnitId]);
  }
  const scopedAccess = createTenantTransactions(access);
  let millis = Date.now();
  const delivery = [];
  const options = {
    pool: iam, accessSigningKey: randomBytes(32), otpPepper: randomBytes(32), now: () => millis,
    async deliverOtp({ destination, code }) { delivery.push({ destination, code }); },
    resolveMembership: ({ identityId, tenantId, membershipId }) => scopedAccess.run(tenantId, async (db) => {
      const { rows } = await db.query(`
        SELECT id AS "membershipId", tenant_id AS "tenantId", org_unit_id AS "orgUnitId"
         FROM identity_access.memberships WHERE identity_id = $1 AND status = 'active'
         AND ($2::uuid IS NULL OR id = $2) AND (expires_at IS NULL OR expires_at > $3)
         LIMIT 2
      `, [identityId, membershipId ?? null, new Date(millis)]);
      return rows.length === 1 ? rows[0] : null;
    }),
  };
  const auth = createAuthService(options);
  const gateway = createServer(createGateway(createAuthGatewayOptions(auth, { GatewayError })));
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => gateway.close((error) => error ? reject(error) : resolve())));
  const base = 'http://127.0.0.1:' + gateway.address().port + '/v1';
  async function http(path, { method = 'POST', body, bearer, tenantHeader } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    if (tenantHeader) headers['X-Tenant-Id'] = tenantHeader;
    const response = await fetch(base + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
    });
    const payload = response.status === 204 ? null : await response.json();
    return { status: response.status, headers: response.headers, ...payload };
  }
  const list = (bearer, tenantHeader, query = '') => http('/me/sessions' + query, { method: 'GET', bearer, tenantHeader });
  const loginTo = (scope) => http('/auth/login', { body: { login, password, ...scope } });

  await t.test('password login selects active membership and hides identity lookup failures', async () => {
    const wrong = await http('/auth/login', { body: { login, password: 'wrong' } });
    const missing = await http('/auth/login', { body: { login: randomUUID() + '@example.test', password } });
    assert.equal(wrong.status, 401);
    assert.equal(missing.status, 401);
    assert.deepEqual(wrong.error, missing.error);
    const forbidden = await loginTo(contextMissing);
    assert.equal(forbidden.status, 401);
    const result = await loginTo(roleA);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.data.tenantId, roleA.tenantId);
    assert.deepEqual(await auth.authenticate(result.data.accessToken), { identityId, sessionId: result.data.sessionId, sessionRevision: 1, ...roleA });
    const row = (await iam.query('SELECT access_hash, refresh_hash FROM identity_access.sessions WHERE id = $1',
      [result.data.sessionId])).rows[0];
    assert.deepEqual(row, { access_hash: digest(result.data.accessToken), refresh_hash: digest(result.data.refreshToken) });
    await assert.rejects(iam.query('SELECT id FROM identity_access.memberships'), { code: '42501' });
  });

  await t.test('OTP verification enforces expiration, attempts, single use and durable request limit', async () => {
    const issue = (value = login) => http('/auth/otp/request', { body: { login: value, ...roleA } });
    const verify = (challengeId, code) => http('/auth/otp/verify', { body: { challengeId, code } });
    const unknown = await issue(randomUUID() + '@example.test');
    const first = await issue();
    assert.equal(unknown.status, 202);
    assert.equal(first.status, 202);
    assert.deepEqual(Object.keys(first.data), Object.keys(unknown.data));
    await setImmediate();
    assert.equal(delivery.length, 1);
    assert.equal(delivery[0].destination, login);
    const firstCode = delivery[0].code;
    const otp = (await iam.query('SELECT code_hash FROM identity_access.otp_challenges WHERE id = $1',
      [first.data.challengeId])).rows[0].code_hash;
    assert.match(otp, /^[0-9a-f]{64}$/);
    assert.notEqual(otp, firstCode);
    millis += 5 * minute;
    assert.equal((await verify(first.data.challengeId, firstCode)).status, 422);

    const second = await issue();
    await setImmediate();
    const secondCode = delivery.at(-1).code;
    const invalidCode = secondCode === '000000' ? '000001' : '000000';
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await verify(second.data.challengeId, invalidCode)).status, 422);
    }
    assert.equal((await verify(second.data.challengeId, secondCode)).status, 422);

    const third = await issue();
    await setImmediate();
    const thirdCode = delivery.at(-1).code;
    assert.equal((await verify(third.data.challengeId, thirdCode)).status, 200);
    assert.equal((await verify(third.data.challengeId, thirdCode)).status, 422);
    assert.equal((await issue()).status, 202);
    const limited = await issue();
    assert.equal(limited.status, 429);
    assert(Number(limited.headers.get('retry-after')) > 0);
    const restarted = createAuthService(options);
    await assert.rejects(restarted.requestOtp({ login }), { code: 'RATE_LIMITED' });
    millis += 15 * minute;
  });

  await t.test('password attempt budgets persist across service instances and reset after the window', async () => {
    const unknownLogin = randomUUID() + '@example.test';
    const body = { login: unknownLogin, password };
    for (let i = 0; i < 8; i += 1) {
      assert.equal((await http('/auth/login', { body })).status, 401);
    }
    const restarted = createAuthService(options);
    await assert.rejects(restarted.login(body), { code: 'RATE_LIMITED' });
    const limited = await http('/auth/login', { body });
    assert.equal(limited.status, 429);
    assert(Number(limited.headers.get('retry-after')) > 0);
    millis += 15 * minute;
    assert.equal((await http('/auth/login', { body })).status, 401);
  });

  await t.test('tenant scope cannot be replaced by a header, and rotation is bound to active membership', async () => {
    const a = (await loginTo(roleA)).data;
    const b = (await loginTo(roleB)).data;
    const aList = await list(a.accessToken, roleB.tenantId, '?limit=1');
    const bList = await list(b.accessToken);
    assert.equal(aList.status, 200);
    assert.equal(bList.status, 200);
    assert(!aList.data.some(({ id }) => id === b.sessionId));
    assert(!bList.data.some(({ id }) => id === a.sessionId));
    assert(aList.meta.nextCursor);
    assert.equal((await list(b.accessToken, undefined, '?limit=1&cursor=' + aList.meta.nextCursor)).status, 400);
    const refused = await http('/auth/refresh', { bearer: a.refreshToken, body: contextMissing });
    assert.equal(refused.status, 401);
    const switched = await http('/auth/refresh', { bearer: a.refreshToken, body: roleB });
    assert.equal(switched.status, 200);
    assert.equal(switched.data.tenantId, roleB.tenantId);
    assert.equal(switched.data.refreshExpiresAt, a.refreshExpiresAt);
    assert.equal(await auth.authenticate(a.accessToken), null);
    assert.equal((await list(switched.data.accessToken)).status, 200);
    const replay = await http('/auth/refresh', { bearer: a.refreshToken });
    assert.equal(replay.status, 401);
    assert.equal((await list(switched.data.accessToken)).status, 401);
    assert.equal((await http('/auth/refresh', { bearer: switched.data.refreshToken })).status, 401);
    const fact = (await iam.query(
      'SELECT event_type, reason FROM identity_access.session_revocations WHERE session_id = $1', [a.sessionId],
    )).rows;
    assert.deepEqual(fact, [{ event_type: 'identity.session_revoked.v1', reason: 'refresh_reuse' }]);
  });

  await t.test('parallel refresh and logout revoke their own session families', async () => {
    const initial = (await loginTo(roleA)).data;
    const responses = await Promise.all(Array.from({ length: 2 }, () => http('/auth/refresh', {
      bearer: initial.refreshToken,
    })));
    assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 401]);
    const rotated = responses.find(({ status }) => status === 200).data;
    assert.equal(await auth.authenticate(rotated.accessToken), null);

    const newSession = (await loginTo(roleA)).data;
    assert.equal((await http('/auth/logout', { bearer: newSession.accessToken })).status, 204);
    assert.equal((await http('/auth/logout', { bearer: newSession.accessToken })).status, 401);
    assert.equal((await http('/auth/refresh', { bearer: newSession.refreshToken })).status, 401);
    const event = (await iam.query(
      'SELECT reason FROM identity_access.session_revocations WHERE session_id = $1', [newSession.sessionId],
    )).rows;
    assert.deepEqual(event, [{ reason: 'logout' }]);
  });

  await t.test('deactivated membership and token deadlines fail at authentication', async () => {
    const b = (await loginTo(roleB)).data;
    assert.equal((await list(b.accessToken)).status, 200);
    await admin.query("UPDATE identity_access.memberships SET status = 'inactive' WHERE tenant_id = $1 AND id = $2",
      [roleB.tenantId, roleB.membershipId]);
    assert.equal((await list(b.accessToken)).status, 401);
    const a = (await loginTo(roleA)).data;
    assert.equal((await list(a.accessToken)).status, 200);
    millis += 15 * minute;
    assert.equal((await list(a.accessToken)).status, 401);
    millis += 30 * 24 * 60 * minute;
    assert.equal((await http('/auth/refresh', { bearer: a.refreshToken })).status, 401);
  });
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createGatewayRuntime } from '../../apps/api-gateway/src/runtime.mjs';
import { hashPassword } from '../../apps/identity-service/src/auth/crypto.mjs';
import { tenancyFixture } from '../S04-W01/gateway-fixture.mjs';
import { fixtureCode } from '../S04-W01/fixture-totp.mjs';

test('live Gateway requires an allowlisted platform session and its own fresh MFA for both approvers', {
  timeout: 45000,
}, async t => {
  const { admin, pools: { tenancyPool, billingPool, ...identityPools } } =
    await tenancyFixture(t, { includeManagement: true });
  async function account() {
    const id = randomUUID();
    const login = id + '@test.invalid';
    const password = randomBytes(24).toString('hex');
    await admin.query(`
      INSERT INTO identity_access.identities (id, login_normalized, status, password_hash)
      VALUES ($1,$2,'active',$3)
    `, [id, login, await hashPassword(password)]);
    return { id, login, password };
  }
  const requester = await account();
  const reviewer = await account();
  const other = await account();
  let tenantId;
  let now = Date.now();
  const { gateway } = createGatewayRuntime({
    identity: {
      ...identityPools, accessSigningKey: randomBytes(32), otpPepper: randomBytes(32),
      mfaEncryptionKey: randomBytes(32), accessPolicy: {}, deliverOtp: async () => {}, now: () => now,
    },
    tenancy: {
      pool: tenancyPool,
      authorizeProvisioning: async ({ identity }) => identity.actor === requester.id ? { kind: 'platform_admin' } : null,
      authorizeStatusChange: async () => true,
      management: {
        billingPool,
        resolvePlatformScopes: async ({ identity }) => tenantId && [requester.id, reviewer.id].includes(identity.actor)
          ? [{ tenantId, requestStatusChange: true, decideStatusChange: true }] : [],
      },
    },
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const base = 'http://127.0.0.1:' + gateway.address().port + '/v1';
  async function send(path, expected, { body, token, headers, method } = {}) {
    const response = await fetch(base + path, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...headers,
      },
      body: body && JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, expected, result.error?.code);
    return result.data;
  }
  const login = async ({ login, password }) => (await send('/auth/login', 200, { body: { login, password } })).accessToken;
  const token = await login(requester);
  const tenant = await send('/tenants', 201, {
    token, headers: { 'Idempotency-Key': randomUUID() }, body: {
      slug: 'fixture-' + randomUUID(), displayName: 'Managed test school', ownerIdentityId: requester.id,
      legalEntity: { name: 'Test legal entity', countryCode: 'IR', registrationNumber: randomUUID() },
    },
  });
  tenantId = tenant.id;
  const requestPath = '/management/status-requests';
  const statusBody = { tenantId, targetStatus: 'suspended', expectedVersion: 1 };
  await send(requestPath, 403, { token, body: statusBody });
  await send('/tenants/' + tenantId + '/status', 403, {
    token, method: 'PATCH', body: { status: 'suspended', expectedVersion: 1 },
  });
  const outsider = await login(other);
  await send('/auth/mfa/step-up', 401, { token: outsider, body: { code: '000000' } });
  await send('/management/overview', 403, { token: outsider });

  async function stepUp(account, accessToken) {
    const enrollment = await send('/auth/mfa/enroll', 200, { token: accessToken, body: { password: account.password } });
    await send('/auth/mfa/enroll/confirm', 200, {
      token: accessToken, body: { challengeId: enrollment.challengeId, code: fixtureCode(enrollment.secret, now) },
    });
    now += 30_000;
    await send('/auth/mfa/step-up', 200, { token: accessToken, body: { code: fixtureCode(enrollment.secret, now) } });
  }
  await stepUp(requester, token);
  const pending = await send(requestPath, 201, { token, body: statusBody });
  const decisionPath = requestPath + '/' + pending.id + '/decision';
  const decision = { tenantId, decision: 'approve' };
  await send(decisionPath, 403, { token, body: decision });
  const reviewerToken = await login(reviewer);
  await send(decisionPath, 403, { token: reviewerToken, body: decision });
  await stepUp(reviewer, reviewerToken);
  const result = await send(decisionPath, 200, { token: reviewerToken, body: decision });
  assert.equal(result.state, 'approved');
  const overview = await send('/management/overview?tenantId=' + tenantId, 200, { token: reviewerToken });
  assert.equal(overview.selected.tenant.status, 'suspended');
});

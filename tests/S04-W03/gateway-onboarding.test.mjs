import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createGatewayRuntime } from '../../apps/api-gateway/src/runtime.mjs';
import { hashPassword } from '../../apps/identity-service/src/auth/crypto.mjs';
import { tenancyFixture } from '../S04-W01/gateway-fixture.mjs';

function fixtureCode(secret, instant) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  assert.match(secret, /^[A-Z2-7]+$/);
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('');
  const seed = Buffer.from(bits.match(/[01]{8}/g).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(instant / 30_000)));
  const digest = createHmac('sha1', seed).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('owner setup resumes across sessions and links the first school, scoped invitation and draft site', {
  timeout: 45_000,
}, async t => {
  const { admin, pools: { tenancyPool, schoolPool, sitesPool, ...identityPools } } =
    await tenancyFixture(t, { includeOnboarding: true });
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
  const operator = await account();
  const owner = await account();
  const manager = await account();
  const firstDeliveryAttempts = new Set();
  const delivered = new Map();
  let now = Date.now();
  const { gateway } = createGatewayRuntime({
    identity: {
      ...identityPools, accessSigningKey: randomBytes(32), otpPepper: randomBytes(32),
      mfaEncryptionKey: randomBytes(32), accessPolicy: {}, now: () => now,
      deliverOtp: async () => {},
      deliverInvitation: async record => {
        if (delivered.has(record.invitationId)) return true;
        if (!firstDeliveryAttempts.has(record.invitationId)) {
          firstDeliveryAttempts.add(record.invitationId);
          return false;
        }
        delivered.set(record.invitationId, record);
        return true;
      },
    },
    tenancy: {
      pool: tenancyPool, authorizeProvisioning: async ({ identity }) => identity.actor === operator.id ? { kind: 'platform_admin' } : null,
      authorizeStatusChange: async () => false, onboarding: { schoolPool, sitesPool },
    },
  });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => new Promise(resolve => gateway.close(resolve)));
  const base = 'http://127.0.0.1:' + gateway.address().port + '/v1';
  async function request(path, expected, { token, body, headers } = {}) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const result = await response.json();
    assert.equal(response.status, expected, result.error?.code);
    return result.data;
  }
  const login = async ({ login, password }, selection = {}) =>
    request('/auth/login', 200, { body: { login, password, ...selection } });
  const platform = await login(operator);
  const provision = () => request('/tenants', 201, {
    token: platform.accessToken,
    headers: { 'Idempotency-Key': randomUUID() },
    body: {
      slug: 'test-' + randomUUID(), displayName: 'Fixture school customer', ownerIdentityId: owner.id,
      legalEntity: { name: 'Fixture entity', countryCode: 'IR', registrationNumber: randomUUID() },
    },
  });
  const first = await provision();
  const second = await provision();
  const scoped = tenant => login(owner, { tenantId: tenant.id, membershipId: tenant.ownerMembershipId });
  let ownerSession = await scoped(first);
  const separate = await scoped(second);
  const read = (token, status = 200) => request('/onboarding', status, { token });
  const start = { version: 0, step: 'organization', draft: {} };
  assert.deepEqual(await read(ownerSession.accessToken), start);
  const advance = (expectedVersion, step, input, status = 200) => request('/onboarding/advance', status, {
    token: ownerSession.accessToken, body: { expectedVersion, step, input },
  });
  await advance(0, 'organization', { kind: 'external', name: 'No owner write', code: 'invalid' }, 422);
  assert.deepEqual(await read(ownerSession.accessToken), start);
  const orgInput = { kind: 'collection', name: 'مجموعهٔ نمونه', code: 'group' };
  const org = await advance(0, 'organization', orgInput);
  assert.equal(org.step, 'school');
  assert.deepEqual(await read(separate.accessToken), start);
  ownerSession = await scoped(first);
  assert.deepEqual(await read(ownerSession.accessToken), org);
  await advance(0, 'organization', orgInput, 412);
  const school = await advance(1, 'school', {
    layout: 'branch', name: 'مدرسهٔ نمونه', code: 'school', branchName: 'شعبهٔ نمونه', branchCode: 'branch',
  });
  assert.equal(school.step, 'invitation');
  await advance(2, 'invitation', { identityId: manager.id }, 403);
  const token = ownerSession.accessToken;
  const enrollment = await request('/auth/mfa/enroll', 200, { token, body: { password: owner.password } });
  await request('/auth/mfa/enroll/confirm', 200, {
    token, body: { challengeId: enrollment.challengeId, code: fixtureCode(enrollment.secret, now) },
  });
  now += 30_000;
  await request('/auth/mfa/step-up', 200, { token, body: { code: fixtureCode(enrollment.secret, now) } });
  await advance(2, 'invitation', { identityId: manager.id }, 503);
  assert.equal((await read(token)).step, 'invitation');
  const invite = await advance(2, 'invitation', { identityId: manager.id });
  assert.equal(invite.step, 'site');
  assert.equal(delivered.size, 1);
  assert.equal(firstDeliveryAttempts.size, 1);
  const sent = delivered.get(invite.draft.invitation.invitationId);
  assert.equal(sent.orgUnitId, school.draft.school.orgUnitId);
  assert.equal(JSON.stringify(invite).includes(sent.token), false);
  const managerSession = await login(manager);
  const accepted = await request('/invitations/accept', 200, {
    token: managerSession.accessToken, body: { tenantId: first.id, token: sent.token },
  });
  assert.equal(accepted.orgUnitId, school.draft.school.orgUnitId);
  const completed = await advance(3, 'site', { name: 'سایت نمونه', slug: 'first-school' });
  assert.equal(completed.step, 'completed');
  assert.equal(completed.draft.site.status, 'draft');
  assert.deepEqual(await read(token), completed);
  assert.deepEqual(await read(separate.accessToken), start);
  const rows = await admin.query(`
    SELECT s.tenant_id, s.org_unit_id, site.draft_slug
    FROM school_enrollment.schools AS s JOIN sites_content.sites AS site
      ON site.tenant_id = s.tenant_id AND site.org_unit_id = s.org_unit_id
    WHERE s.tenant_id = $1 AND s.id = $2 AND site.id = $3
  `, [first.id, school.draft.school.schoolId, completed.draft.site.siteId]);
  assert.deepEqual(rows.rows, [{
    tenant_id: first.id, org_unit_id: school.draft.school.orgUnitId, draft_slug: 'first-school',
  }]);
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  appendIamSecurityEvent, appendTenantSecurityEvent, createSecurityAudit,
} from '../../apps/audit-service/src/service.mjs';

test('audit append parameters contain fixed fields even when input carries private data', async () => {
  const queries = [];
  const db = { async query(sql, values) { queries.push({ sql, values }); } };
  const actor = randomUUID();
  const tenantId = randomUUID();
  const membershipId = randomUUID();
  const requestId = randomUUID();
  const resourceId = randomUUID();
  const sessionId = randomUUID();
  const principal = { actor, tenantId, scope: tenantId, membershipId, accessToken: 'sensitive-fixture' };
  const details = { body: 'student-contact-fixture', password: 'sensitive-password', roleName: 'secret-name' };
  await appendTenantSecurityEvent(db, {
    ...details, event: 'security.role_updated.v1', principal, requestId, resourceId,
  });
  await appendTenantSecurityEvent(db, {
    ...details, event: 'security.sensitive_access.v1', principal, requestId, resourceId, outcome: 'denied',
  });
  await appendIamSecurityEvent(db, {
    ...details, outcome: 'success', actorId: actor, requestId, tenantId, membershipId, sessionId,
  });
  await appendIamSecurityEvent(db, { ...details, outcome: 'denied', requestId });
  assert.deepEqual(queries.map(({ values }) => values), [
    ['security.role_updated.v1', actor, membershipId, requestId, resourceId, 'success'],
    ['security.sensitive_access.v1', actor, membershipId, requestId, null, 'denied'],
    [actor, requestId, tenantId, membershipId, sessionId, 'success'],
    [null, requestId, null, null, null, 'denied'],
  ]);
  const serialized = JSON.stringify(queries);
  for (const value of [...Object.values(details), principal.accessToken]) {
    assert.equal(serialized.includes(value), false);
  }
});

test('audit rejects inconsistent scopes and routes writes to the selected owner', async () => {
  const actor = randomUUID();
  const tenantId = randomUUID();
  const membershipId = randomUUID();
  const principal = { actor, tenantId, scope: tenantId, membershipId };
  const calls = [];
  const events = {
    accessTransactions: { async run(scope, work) { calls.push(['access', scope]); await work(db); } },
    peopleTransactions: { async run(scope, work) { calls.push(['people', scope]); await work(db); } },
  };
  const db = { async query() {} };
  const audit = createSecurityAudit(events);
  await audit.recordTenant({ event: 'security.role_assigned.v1', principal, resourceId: randomUUID() });
  await audit.recordTenant({ event: 'security.sensitive_access.v1', principal });
  await audit.recordTenant({ event: 'security.sensitive_access.v1', principal, owner: 'access' });
  assert.deepEqual(calls, [['access', tenantId], ['people', tenantId], ['access', tenantId]]);
  assert.throws(() => audit.recordTenant({
    event: 'security.sensitive_access.v1', principal: { ...principal, scope: randomUUID() },
  }), { message: 'Invalid security audit event' });
  assert.throws(() => audit.recordTenant({
    event: 'security.role_updated.v1', principal, owner: 'people',
  }), { message: 'Invalid security audit event' });
  for (const payload of [
    { outcome: 'success', requestId: randomUUID() },
    { outcome: 'denied', tenantId, membershipId },
    { outcome: 'success', actorId: actor, tenantId },
  ]) {
    await assert.rejects(appendIamSecurityEvent(db, payload), { message: 'Invalid security audit event' });
  }
  assert.throws(() => createSecurityAudit().recordTenant({
    event: 'security.sensitive_access.v1', principal,
  }), { message: 'Security audit writer is unavailable' });
});

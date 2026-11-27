import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createOrganizationTree } from '../../apps/tenant-org-service/src/tree.mjs';

test('organization scope is verified before a query or a write', async () => {
  const tenantId = randomUUID();
  const identity = { actor: randomUUID(), scope: tenantId, tenantId, membershipId: randomUUID() };
  const evaluations = [];
  const tree = createOrganizationTree({
    transactions: { run() { throw new Error('Unexpected database access'); } },
    async authorize(check) { evaluations.push(check); return false; },
  });
  await assert.rejects(tree.list({ identity: { ...identity, scope: randomUUID() }, page: { limit: 25 } }), { message: 'NOT_FOUND' });
  assert.equal(evaluations.length, 0);
  await assert.rejects(tree.list({ identity, page: { limit: 25 } }), { message: 'FORBIDDEN' });
  await assert.rejects(tree.create({ identity, body: {} }), { message: 'FORBIDDEN' });
  assert.deepEqual(evaluations.map(({ action, orgUnitId, identity }) => [action, orgUnitId, identity.tenantId]), [
    ['tenancy.org.read', null, tenantId], ['tenancy.org.write', null, tenantId],
  ]);
});

test('strict create and move contracts reject invalid fields before storage', async () => {
  const tenantId = randomUUID();
  const identity = { actor: randomUUID(), scope: tenantId, tenantId, membershipId: randomUUID() };
  const orgUnitId = randomUUID();
  const tree = createOrganizationTree({
    transactions: { run() { throw new Error('Unexpected database access'); } },
    authorize: async () => true,
  });
  const good = { kind: 'school', code: 'sample-school', name: 'مدرسهٔ نمونه', idempotencyKey: 'sample-key' };
  for (const fields of [
    { kind: [] }, { code: 'Invalid Code' }, { code: 'trailing\n' }, { name: '\u0000Hidden' },
    { parentId: 10 }, { idempotencyKey: 'short' }, { idempotencyKey: 'trailing-key\n' }, { tenantId },
  ]) {
    await assert.rejects(tree.create({ identity, body: { ...good, ...fields } }), { message: 'VALIDATION_FAILED' });
  }
  await assert.rejects(tree.list({ identity, page: { limit: 101 } }), { message: 'INVALID_REQUEST' });
  await assert.rejects(tree.move({ identity, orgUnitId, body: { parentId: null } }), { message: 'PRECONDITION_REQUIRED' });
  for (const ifMatch of ['W/"1"', '"01"', '"2147483648"', '"1"\n']) {
    await assert.rejects(tree.move({ identity, orgUnitId, body: { parentId: null }, ifMatch }), { message: 'VALIDATION_FAILED' });
  }
});

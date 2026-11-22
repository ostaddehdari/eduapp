import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const decisionUrl = new URL('../../docs/decisions/product-priority-baseline.v1.json', import.meta.url);
const baseline = JSON.parse(await readFile(decisionUrl, 'utf8'));

function validateBaseline(decision) {
  if (decision.status !== 'accepted') throw new Error('DECISION_NOT_ACCEPTED');
  assert.deepEqual(decision.priority_order, ['P0', 'P1', 'P2', 'P3']);

  for (const priority of decision.priority_order) {
    if (!decision.priorities[priority]) throw new Error(`MISSING_PRIORITY_${priority}`);
    if (!decision.priorities[priority].exit_gate) throw new Error(`MISSING_EXIT_GATE_${priority}`);
  }

  const sources = new Map(decision.sources.map((source) => [source.id, source]));
  assert.equal(decision.conflict_resolution.p0_p1_authority, 'engineering-2.1');
  assert.equal(decision.conflict_resolution.p2_p3_coverage, 'comprehensive-proposal');
  assert.equal(sources.get('har-v1.1')?.authority, 'evidence_only');
  assert.equal(sources.get('har-v1.1')?.may_define_api, false);
  assert.equal(decision.conflict_resolution.har_observation_is_contract, false);
  assert.ok(decision.priorities.P0.requirements.includes('FR-001'));
  assert.deepEqual(decision.commercial_rules.p0_may_promise, ['P0']);
  assert.equal(decision.commercial_rules.p2_p3_are_mvp_commitments, false);
  return true;
}

function resolveTenantContext(boundary, requestedTenantId) {
  const membership = boundary.memberships.find(
    (candidate) => candidate.tenant_id === requestedTenantId && candidate.active,
  );

  if (!membership) {
    const error = new Error(boundary.error_code);
    error.code = boundary.error_code;
    throw error;
  }

  return {
    tenant_id: membership.tenant_id,
    role: membership.role,
  };
}

test('accepted baseline fixes source authority and all P0-P3 gates', () => {
  assert.equal(validateBaseline(baseline), true);
});

test('the same person receives an independent role in the second tenant', () => {
  const first = resolveTenantContext(baseline.tenant_boundary, 'tenant-a');
  const second = resolveTenantContext(baseline.tenant_boundary, 'tenant-b');

  assert.deepEqual(first, { tenant_id: 'tenant-a', role: 'owner' });
  assert.deepEqual(second, { tenant_id: 'tenant-b', role: 'teacher' });
  assert.notEqual(first.role, second.role);
  assert.equal(baseline.tenant_boundary.cross_tenant_role_carry_over, false);
});

test('a tenant without an active membership is rejected with a stable error', () => {
  assert.throws(
    () => resolveTenantContext(baseline.tenant_boundary, 'tenant-c'),
    (error) => error.code === 'TENANT_CONTEXT_MISMATCH',
  );
});

test('negative case: HAR evidence cannot be promoted to an API contract', () => {
  const invalid = structuredClone(baseline);
  const har = invalid.sources.find((source) => source.id === 'har-v1.1');
  har.authority = 'api_contract';
  har.may_define_api = true;

  assert.throws(() => validateBaseline(invalid));
});

test('negative case: removing a priority gate fails validation', () => {
  const invalid = structuredClone(baseline);
  delete invalid.priorities.P3;

  assert.throws(() => validateBaseline(invalid), /MISSING_PRIORITY_P3/);
});

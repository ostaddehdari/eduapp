import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const gate = JSON.parse(readFileSync(new URL('../docs/gates/S03.json', import.meta.url), 'utf8'));
const sha = /^[0-9a-f]{40}$/;
const runUrl = /^https:\/\/github\.com\/ostaddehdari\/eduapp\/actions\/runs\/[0-9]+$/;
const checks = [
  'authentication_and_sessions', 'people_and_membership', 'roles_and_field_masking',
  'mfa_and_recovery', 'append_only_security_audit',
];

assert.equal(gate.schema_version, '1.0');
assert.equal(gate.version, '1.0.0');
assert.equal(gate.stage_id, 'S03');
assert.equal(gate.gate_id, 'S03-W06-T01');
assert.equal(gate.decision, 'GO_TO_S04_TENANT_ORGANIZATION_DEVELOPMENT');
assert.equal(gate.production_authorization, false);
assert.equal(gate.providers_activation_authorization, false);
assert(Number.isFinite(Date.parse(gate.evaluated_at)));
assert.match(gate.evaluated_source_sha, sha);
assert.match(gate.evaluated_workflow, runUrl);
assert.deepEqual(gate.requirement_ids, ['OPS-001']);
assert.equal(gate.test_environment, 'isolated_ci_postgresql');
assert.equal(gate.tenant_boundary.result, 'no_cross_tenant_exposure_observed_in_tested_scenarios');
assert.deepEqual(gate.tenant_boundary.coverage, checks);
assert.deepEqual(gate.smoke, { passed: 21, failed: 0, skipped: 0 });

assert.equal(gate.works.length, checks.length);
for (const [index, work] of gate.works.entries()) {
  const expected = 'S03-W0' + (index + 1);
  assert.equal(work.id, expected);
  assert.equal(work.terminal_task, expected + '-T03');
  assert.equal(work.status, 'accepted');
  assert.equal(work.coverage, checks[index]);
  assert.match(work.source_commit, sha);
  assert.match(work.ci, runUrl);
  assert.equal(work.log, 'logs/' + work.terminal_task + '/attempt-001.md');
  assert.match(work.suite, new RegExp('^tests/' + expected + '/[a-z0-9.-]+\\.test\\.mjs$'));
  assert(existsSync(new URL('../' + work.suite, import.meta.url)), work.suite);
}
assert.equal(gate.works.at(-1).source_commit, gate.evaluated_source_sha);
assert.equal(gate.works.at(-1).ci, gate.evaluated_workflow);

console.log('S03 stage gate valid: five accepted works and an isolation smoke pass. GO to S04 development.');

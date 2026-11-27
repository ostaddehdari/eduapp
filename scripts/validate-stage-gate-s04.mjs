import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const gate = JSON.parse(readFileSync(new URL('../docs/gates/S04.json', import.meta.url), 'utf8'));
const sha = /^[0-9a-f]{40}$/;
const ci = /^https:\/\/github\.com\/ostaddehdari\/eduapp\/actions\/runs\/[0-9]+$/;
assert.equal(gate.schema_version, '1.0');
assert.equal(gate.version, '1.0.0');
assert.equal(gate.stage_id, 'S04');
assert.equal(gate.gate_id, 'S04-W07-T01');
assert.equal(gate.decision, 'GO_TO_S05_COMMERCE_DEVELOPMENT');
assert.equal(gate.production_authorization, false);
assert.equal(gate.test_environment, 'isolated_ci_postgresql');
assert(Number.isFinite(Date.parse(gate.evaluated_at)));
assert.match(gate.evaluated_source_sha, sha);
assert.match(gate.evaluated_workflow, ci);
assert.equal(gate.works.length, 6);
for (const [index, work] of gate.works.entries()) {
  const id = 'S04-W0' + (index + 1);
  assert.equal(work.id, id);
  assert.equal(work.terminal_task, id + '-T03');
  assert.equal(work.status, 'accepted');
  assert.match(work.source_commit, sha);
  assert.match(work.ci, ci);
  assert.equal(work.log, 'logs/' + work.terminal_task + '/attempt-001.md');
  assert.match(work.suite, new RegExp('^tests/' + id + '/[a-z0-9.-]+\\.test\\.mjs$'));
  assert(existsSync(new URL('../' + work.suite, import.meta.url)));
}
assert.deepEqual(gate.tenant_boundary.coverage, gate.works.map(work => work.id));
assert.equal(gate.tenant_boundary.result, 'no_cross_tenant_exposure_observed_in_tested_scenarios');
assert.equal(gate.production_preview.runtime_api_readiness, 'HTTP_404_UNVERIFIED');
console.log('S04 gate valid: six accepted works, development only; production API remains unverified.');

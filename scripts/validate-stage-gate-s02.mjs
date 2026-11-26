import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const gate = JSON.parse(readFileSync(new URL('../docs/gates/S02.json', import.meta.url), 'utf8'));
const sha = /^[0-9a-f]{40}$/;
const workflow = /^https:\/\/github\.com\/ostaddehdari\/eduapp\/actions\/runs\/[0-9]+$/;

assert.equal(gate.gate_id, 'S02-W07-T01');
assert.equal(gate.version, '1.0.0');
assert.equal(gate.decision, 'GO_TO_S03_IDENTITY_DEVELOPMENT');
assert.equal(gate.production_authorization, false);
assert.equal(gate.providers_activation_authorization, false);
assert.match(gate.evaluated_source_sha, sha);
assert.match(gate.evaluated_workflow, workflow);
assert.equal(gate.tenant_boundary.result, 'no_cross_tenant_exposure_observed_in_tested_scenarios');
assert.deepEqual(gate.tenant_boundary.coverage, ['gateway', 'postgresql', 'event_delivery', 'observability', 'ui_preview']);

assert.equal(gate.works.length, 6);
for (const [index, item] of gate.works.entries()) {
  const expected = 'S02-W0' + (index + 1);
  assert.equal(item.id, expected);
  assert.equal(item.terminal_task, expected + '-T03');
  assert.equal(item.status, 'accepted');
  assert.match(item.source_commit, sha);
  assert.match(item.ci, workflow);
  assert.equal(item.log, `logs/${item.terminal_task}/attempt-001.md`);
  assert.match(item.suite, new RegExp(`^tests/${expected}/[a-z0-9.-]+\\.test\\.mjs$`));
  assert(existsSync(new URL('../' + item.suite, import.meta.url)), item.suite);
}

console.log('S02 stage gate valid: 6 accepted works, verified tenant-boundary evidence, GO to S03 identity development.');

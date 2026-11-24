#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const gate = JSON.parse(readFileSync(resolve(root, "docs/gates/S01.json"), "utf8"));
const markdown = readFileSync(resolve(root, "docs/gates/S01.md"), "utf8");

assert.equal(gate.schema_version, "1.0");
assert.equal(gate.gate_id, "S01-W05-T01");
assert.equal(gate.version, "1.0.0");
assert.equal(gate.stage_id, "S01");
assert.equal(gate.status, "accepted");
assert.deepEqual(gate.requirement_ids, ["OPS-001"]);
assert.equal(gate.decision, "GO_TO_S02_FOUNDATION");
assert.equal(gate.production_authorization, false);
assert.equal(gate.provider_activation_authorization, false);
assert.equal(gate.next_task, "S02-W01-T01");

const expectedDependencies = new Map([
  ["S01-W01", { terminal: "S01-W01-T03", tests: 5, source: "8bbea24233dde1152312e642cd089331a99f1337" }],
  ["S01-W02", { terminal: "S01-W02-T03", tests: 6, source: "0decaea52d35ea5a1d82053085a7a00cd274777b" }],
  ["S01-W03", { terminal: "S01-W03-T03", tests: 7, source: "98236b6a4fdfa2207f375e36943bb03201989ce0" }],
  ["S01-W04", { terminal: "S01-W04-T03", tests: 14, source: "a3bf30983d02836ebbad91485b1bd2d3a02cd0d2" }]
]);

assert.equal(gate.dependency_evidence.length, expectedDependencies.size);
for (const item of gate.dependency_evidence) {
  const expected = expectedDependencies.get(item.work_id);
  assert(expected, `unexpected work: ${item.work_id}`);
  assert.equal(item.terminal_task, expected.terminal);
  assert.equal(item.status, "done");
  assert.equal(item.source_commit, expected.source);
  assert.equal(item.automated_tests, expected.tests);
  assert.match(item.control_commit, /^[a-f0-9]{40}$/);
  assert.match(item.log, /^logs\/S01-W0[1-4]-T03\/attempt-001\.md$/);
  assert(item.evidence_summary.length > 20);
}

assert.equal(gate.validators.length, 6);
for (const validator of gate.validators) {
  assert.equal(validator.status, "passed");
  const script = validator.command.replace(/^node /, "");
  assert(existsSync(resolve(root, script)), `validator not found: ${script}`);
}

assert.equal(gate.test_suites.length, 4);
const testTotal = gate.test_suites.reduce((sum, suite) => sum + suite.passed, 0);
assert.equal(testTotal, 32);
for (const suite of gate.test_suites) {
  assert(existsSync(resolve(root, suite.path)), `test suite not found: ${suite.path}`);
  assert(suite.passed > 0);
  assert.equal(suite.failed, 0);
  assert.equal(suite.skipped, 0);
}

assert.equal(gate.tenant_isolation_evidence.length, 4);
assert.deepEqual(new Set(gate.tenant_isolation_evidence.map((item) => item.work_id)), new Set(expectedDependencies.keys()));
for (const isolation of gate.tenant_isolation_evidence) {
  assert.equal(isolation.state_mutation, false);
  assert.equal(isolation.data_leak_detected, false);
  assert(isolation.expected_error.length > 5);
}

assert.equal(gate.exit_criteria.length, 5);
assert(gate.exit_criteria.every((item) => item.status === "passed" && item.evidence.length > 20));
assert.equal(gate.guarded_open_decisions.length, 3);
for (const decision of gate.guarded_open_decisions) {
  assert.equal(decision.status, "unresolved");
  assert(decision.blocks.length > 0);
  assert.deepEqual(decision.does_not_block, ["S02_foundation_engineering"]);
}

assert.deepEqual(gate.summary, {
  completed_works: 4,
  validators_passed: 6,
  automated_tests_passed: 32,
  automated_tests_failed: 0,
  automated_tests_skipped: 0,
  tenant_leaks_detected: 0,
  critical_blockers: 0
});

assert(markdown.includes("GO برای `S02-W01-T01`"));
assert(markdown.includes("NO-GO برای production"));
assert(markdown.includes("۳۲ آزمون PASS"));

console.log("S01 stage gate valid: 4 works, 6 validators, 32 tests, 0 tenant leaks, GO to S02 foundation only");

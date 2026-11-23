#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

const prd = readJson('docs/product/S01-W02.json');
const contract = readJson('docs/contracts/S01-W02.json');
const openapi = readJson('preview/api/openapi.json');
const markdown = readFileSync(resolve(root, 'docs/product/S01-W02.md'), 'utf8');

assert.equal(prd.schema_version, '1.0');
assert.equal(prd.prd_id, 'S01-W02');
assert.equal(prd.version, '1.0.0');
assert.equal(prd.status, 'accepted');
assert.equal(prd.phase, 'P0');
assert.deepEqual(new Set(prd.requirement_ids), new Set(['FR-003', 'FR-006']));
assert.equal(prd.source_contract.contract_id, contract.contract_id);
assert.equal(prd.source_contract.version, contract.version);

const openapiOperations = new Map();
for (const [path, pathItem] of Object.entries(openapi.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (operation && typeof operation === 'object' && operation.operationId) {
      openapiOperations.set(operation.operationId, { method: method.toUpperCase(), path });
    }
  }
}

const contractOperations = new Map(contract.api_contracts.map((item) => [item.operation_id, item]));
assert.deepEqual(prd.journey.states, contract.journey.states);
assert.equal(prd.journey.steps.length, contract.journey.steps.length);

for (const step of prd.journey.steps) {
  assert.ok(contractOperations.has(step.operation_id), `unknown contract operation: ${step.operation_id}`);
  assert.ok(openapiOperations.has(step.operation_id), `missing OpenAPI operation: ${step.operation_id}`);
  assert.ok(step.user_result.length > 10, `missing user result: ${step.operation_id}`);
}

const contractScenarios = new Map(contract.acceptance_scenarios.map((item) => [item.id, item]));
const prdScenarios = new Map(prd.acceptance_scenarios.map((item) => [item.id, item]));
assert.equal(prdScenarios.size, prd.acceptance_scenarios.length, 'duplicate PRD scenario id');

for (const [id, source] of contractScenarios) {
  const scenario = prdScenarios.get(id);
  assert.ok(scenario, `missing contract scenario: ${id}`);
  assert.equal(scenario.expected, source.expected, `weakened expected result: ${id}`);
  assert.equal(scenario.error ?? null, source.error ?? null, `changed error: ${id}`);
  assert.ok(scenario.given.length && scenario.when.length && scenario.then.length, `incomplete GWT: ${id}`);
  assert.ok(markdown.includes(`\`${id}\``), `scenario missing from Markdown: ${id}`);
  for (const operationId of scenario.operation_ids) {
    assert.ok(contractOperations.has(operationId), `scenario uses unknown operation: ${operationId}`);
    assert.ok(openapiOperations.has(operationId), `scenario operation missing from OpenAPI: ${operationId}`);
  }
}

const replay = prdScenarios.get('duplicate-payment-event');
assert.equal(replay.repeat_count, 5);
assert.ok(replay.then.some((line) => /one ledger effect, entitlement, activation and tenant/.test(line)));

assert.deepEqual(
  new Set(prd.organization_models.map((model) => model.id)),
  new Set(['independent_school', 'branched_school'])
);

const contractOwnership = new Map(contract.data_ownership.map((item) => [item.owner, item.tables]));
const prdOwnership = new Map(prd.ownership_boundaries.map((item) => [item.owner, item.writes]));
assert.deepEqual(new Set(prdOwnership.keys()), new Set(contractOwnership.keys()));

const allTables = [];
for (const [owner, tables] of contractOwnership) {
  assert.deepEqual(new Set(prdOwnership.get(owner)), new Set(tables), `ownership mismatch: ${owner}`);
  allTables.push(...tables);
}
assert.equal(allTables.length, 19);
assert.equal(new Set(allTables).size, 19, 'a table has more than one owner');

for (const metric of prd.telemetry) {
  const fields = [...metric.dimensions, ...metric.forbidden_dimensions].join(' ').toLowerCase();
  assert.ok(!metric.dimensions.some((field) => /card|phone|email|child|secret|payload/.test(field)), `unsafe metric dimension: ${metric.name}`);
  assert.ok(fields.length > 0);
}

for (const heading of ['مسیر عملیاتی', 'مرز مالکیت داده', 'سناریوهای پذیرش', 'Definition of Done']) {
  assert.ok(markdown.includes(heading), `missing Markdown section: ${heading}`);
}

console.log(
  `Commercial journey PRD valid: ${prd.journey.steps.length} steps, ` +
  `${prd.acceptance_scenarios.length} scenarios, ${allTables.length} owned tables, ` +
  `${prd.organization_models.length} organization models`
);

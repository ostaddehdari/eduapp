#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const contract = readJson('docs/contracts/S01-W03.json');
const openapi = readJson('preview/api/openapi.json');
const markdown = readFileSync(resolve(root, 'docs/contracts/S01-W03.md'), 'utf8');

assert.equal(contract.schema_version, '1.0');
assert.equal(contract.contract_id, 'S01-W03');
assert.equal(contract.version, '1.0.0');
assert.equal(contract.status, 'accepted');
assert.deepEqual(contract.requirement_ids, ['DATA-001']);
assert.equal(contract.architecture_style, 'modular_monolith_with_explicit_bounded_contexts');

const contextIds = new Set(contract.bounded_contexts.map((context) => context.id));
assert.equal(contextIds.size, 10);
assert.equal(contextIds.size, contract.bounded_contexts.length, 'duplicate bounded context');

const runtimes = new Set(contract.initial_deployment.runtime_units.map((unit) => unit.id));
assert.deepEqual(runtimes, new Set(['api', 'worker', 'public-web', 'control-panel']));
assert.equal(contract.initial_deployment.datastores[0].id, 'postgres');
for (const dependency of contract.initial_deployment.deferred_dependencies) {
  assert.match(dependency.status, /^deferred_/);
}

const ownerTables = new Map();
const allTables = [];
for (const item of contract.table_ownership) {
  assert.ok(contextIds.has(item.context), `unknown table context: ${item.context}`);
  assert.ok(!ownerTables.has(item.owner), `duplicate owner block: ${item.owner}`);
  ownerTables.set(item.owner, item.tables);
  allTables.push(...item.tables);
}
assert.equal(allTables.length, 36);
assert.equal(new Set(allTables).size, 36, 'table assigned to more than one owner');

const tagOwners = new Map(contract.api_tag_ownership.map((item) => [item.tag, item.context]));
assert.equal(tagOwners.size, contract.api_tag_ownership.length, 'duplicate API tag owner');
for (const context of tagOwners.values()) assert.ok(contextIds.has(context));

const operationIds = [];
for (const pathItem of Object.values(openapi.paths ?? {})) {
  for (const operation of Object.values(pathItem)) {
    if (!operation || typeof operation !== 'object' || !operation.operationId) continue;
    assert.equal(operation.tags?.length, 1, `operation must have one owning tag: ${operation.operationId}`);
    assert.ok(tagOwners.has(operation.tags[0]), `unowned OpenAPI tag: ${operation.tags[0]}`);
    operationIds.push(operation.operationId);
  }
}
assert.ok(operationIds.length >= 64, 'the original API surface must be preserved');
assert.equal(new Set(operationIds).size, operationIds.length, 'duplicate operationId');

assert.equal(contract.event_contracts.length, 10);
for (const event of contract.event_contracts) {
  assert.match(event.type, /\.v1$/);
  assert.ok(contextIds.has(event.producer), `unknown producer: ${event.producer}`);
  assert.ok(event.consumers.length > 0);
  for (const consumer of event.consumers) assert.ok(contextIds.has(consumer), `unknown consumer: ${consumer}`);
  assert.ok(event.dedupe_key.length > 5);
}

assert.equal(contract.access_matrix.length, 7);
for (const actor of contract.access_matrix) {
  assert.ok(actor.allow.length > 0 && actor.deny.length > 0, `incomplete access matrix: ${actor.actor}`);
}

const rules = new Set(contract.data_rules);
for (const rule of [
  'tenant_owned_rows_require_tenant_id_not_null',
  'shared_database_cross_row_references_use_compound_tenant_foreign_keys',
  'connection_pool_reuse_must_reset_and_rebind_tenant_context',
  'financial_mutations_require_stable_idempotency_keys_and_append_only_ledger',
  'no_shared_repository_or_orm_model_across_context_owners'
]) assert.ok(rules.has(rule), `missing DATA-001 rule: ${rule}`);

const gates = new Set(contract.split_gates.map((gate) => gate.id));
for (const gate of ['contract_readiness', 'data_migration_readiness', 'cost_review', 'measured_pressure']) {
  assert.ok(gates.has(gate), `missing split gate: ${gate}`);
}
assert.equal(contract.split_policy.default, 'deferred');

const scenarios = new Map(contract.acceptance_scenarios.map((scenario) => [scenario.id, scenario]));
assert.equal(scenarios.size, 8);
assert.equal(scenarios.get('direct-cross-context-write').error, 'FOREIGN_DATA_OWNER');
assert.equal(scenarios.get('tenant-pool-reuse').error, 'TENANT_CONTEXT_MISMATCH');
assert.equal(scenarios.get('premature-service-split').error, 'SPLIT_EVIDENCE_INCOMPLETE');

for (const heading of ['bounded contextها', 'مالکیت جدول', 'مالکیت API و رویداد', 'دروازه split', 'سناریوهای پذیرش']) {
  assert.ok(markdown.includes(heading), `missing Markdown section: ${heading}`);
}

console.log(
  `Service boundary contract valid: ${contextIds.size} contexts, ${allTables.length} tables, ` +
  `${operationIds.length} API operations, ${contract.event_contracts.length} events, ` +
  `${contract.split_gates.length} split gates`
);

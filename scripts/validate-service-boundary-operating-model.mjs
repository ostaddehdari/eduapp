import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const contractUrl = new URL('../docs/contracts/S01-W03.json', import.meta.url);
const modelUrl = new URL('../docs/architecture/service-boundary-operating-model.v1.json', import.meta.url);

const contract = JSON.parse(await readFile(contractUrl, 'utf8'));
const model = JSON.parse(await readFile(modelUrl, 'utf8'));

const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b));
const unique = (values, label) => {
  assert.equal(new Set(values).size, values.length, `${label}_MUST_BE_UNIQUE`);
};

assert.equal(model.status, 'accepted', 'OPERATING_MODEL_NOT_ACCEPTED');
assert.equal(model.contract.id, contract.contract_id, 'CONTRACT_ID_MISMATCH');
assert.equal(model.contract.version, contract.version, 'CONTRACT_VERSION_MISMATCH');
assert.ok(model.requirement_ids.includes('DATA-001'), 'DATA_001_NOT_TRACED');
assert.match(model.decision.adr, /ADR-0002/, 'ADR_REFERENCE_MISSING');

const contractContexts = contract.bounded_contexts.map(({ id }) => id);
const modelContexts = model.context_routes.map(({ context }) => context);
unique(modelContexts, 'CONTEXT_ROUTE');
assert.deepEqual(sorted(modelContexts), sorted(contractContexts), 'CONTEXT_ROUTE_COVERAGE_MISMATCH');

for (const route of model.context_routes) {
  assert.equal(route.primary_runtime, 'api', `INVALID_PRIMARY_RUNTIME_${route.context}`);
  assert.equal(route.sync_entrypoint, 'application_service', `INVALID_ENTRYPOINT_${route.context}`);
  assert.equal(route.authorization_owner, 'context', `INVALID_AUTHORIZATION_OWNER_${route.context}`);
  assert.ok(route.transaction_boundary.startsWith('owned_schema'), `INVALID_TRANSACTION_BOUNDARY_${route.context}`);
  assert.ok(route.observability.includes('request_id'), `REQUEST_ID_MISSING_${route.context}`);
}

const contractRuntimes = contract.initial_deployment.runtime_units.map(({ id }) => id);
const modelRuntimes = model.runtime_topology.map(({ id }) => id);
unique(modelRuntimes, 'RUNTIME');
assert.deepEqual(sorted(modelRuntimes), sorted(contractRuntimes), 'RUNTIME_TOPOLOGY_MISMATCH');

const contractDependencies = new Map(contract.initial_deployment.deferred_dependencies.map((item) => [item.id, item.status]));
for (const dependency of model.deferred_dependencies) {
  assert.equal(dependency.status, contractDependencies.get(dependency.id), `DEFERRED_DEPENDENCY_MISMATCH_${dependency.id}`);
}
assert.equal(model.deferred_dependencies.find(({ id }) => id === 'redis')?.source_of_truth, false);
assert.equal(model.deferred_dependencies.find(({ id }) => id === 'rabbitmq')?.replaces_transactional_outbox, false);

const contractOwners = contract.table_ownership.map(({ owner, context }) => `${owner}:${context}`);
const modelOwners = model.ownership_runtime_map.map(({ owner, context }) => `${owner}:${context}`);
unique(modelOwners, 'OWNER_RUNTIME_MAPPING');
assert.deepEqual(sorted(modelOwners), sorted(contractOwners), 'OWNER_RUNTIME_COVERAGE_MISMATCH');
for (const owner of model.ownership_runtime_map) {
  assert.ok(modelContexts.includes(owner.context), `UNKNOWN_OWNER_CONTEXT_${owner.owner}`);
  assert.ok(owner.schema, `OWNER_SCHEMA_MISSING_${owner.owner}`);
  assert.ok(owner.write_runtime, `WRITE_RUNTIME_MISSING_${owner.owner}`);
}

const normalizeTag = ({ tag, context }) => `${tag}:${context}`;
assert.deepEqual(sorted(model.route_registry.map(normalizeTag)), sorted(contract.api_tag_ownership.map(normalizeTag)), 'API_ROUTE_OWNERSHIP_MISMATCH');
unique(model.route_registry.map(({ tag }) => tag), 'API_TAG');

const normalizeEvent = ({ type, producer, consumers, dedupe_key }) =>
  `${type}:${producer}:${sorted(consumers).join(',')}:${dedupe_key}`;
assert.deepEqual(sorted(model.event_delivery.map(normalizeEvent)), sorted(contract.event_contracts.map(normalizeEvent)), 'EVENT_DELIVERY_MISMATCH');
unique(model.event_delivery.map(({ type }) => type), 'EVENT_TYPE');

const requiredFlows = [
  'authenticated_command',
  'financial_command',
  'event_delivery',
  'tenant_context_switch',
  'owner_schema_migration',
  'service_split_request',
];
const flowIds = model.operational_flows.map(({ id }) => id);
unique(flowIds, 'OPERATIONAL_FLOW');
for (const requiredFlow of requiredFlows) {
  assert.ok(flowIds.includes(requiredFlow), `MISSING_FLOW_${requiredFlow}`);
}
for (const flow of model.operational_flows) {
  assert.ok(flow.steps.length >= 5, `FLOW_TOO_SHORT_${flow.id}`);
  assert.ok(flow.fail_closed.length >= 1, `FAIL_CLOSED_POLICY_MISSING_${flow.id}`);
}

const environments = new Map(model.environment_policy.map((item) => [item.environment, item]));
for (const name of ['development', 'staging', 'production']) {
  assert.equal(environments.get(name)?.isolated_database, true, `DATABASE_NOT_ISOLATED_${name}`);
  assert.equal(environments.get(name)?.isolated_secrets, true, `SECRETS_NOT_ISOLATED_${name}`);
}
assert.equal(environments.get('development').production_data_allowed, false);
assert.equal(environments.get('staging').production_data_allowed, false);

const contractGates = contract.split_gates.map(({ id }) => id);
const modelGates = [...model.split_decision.required_always, ...model.split_decision.required_any];
unique(modelGates, 'SPLIT_GATE');
assert.deepEqual(sorted(modelGates), sorted(contractGates), 'SPLIT_GATE_COVERAGE_MISMATCH');
assert.deepEqual(sorted(model.split_decision.required_always), sorted(['contract_readiness', 'data_migration_readiness', 'cost_review']));
assert.deepEqual(sorted(model.split_decision.required_any), sorted(['independent_team', 'measured_pressure', 'independent_slo_or_security']));
assert.equal(model.split_decision.automatic_split, false, 'AUTOMATIC_SPLIT_FORBIDDEN');
assert.equal(model.split_decision.incomplete_error, 'SPLIT_EVIDENCE_INCOMPLETE');
assert.equal(model.decision.default_action, 'remain_in_modular_monolith');

for (const changeType of ['api', 'event', 'data_ownership', 'deployment']) {
  assert.ok(model.change_control[changeType]?.length >= 3, `CHANGE_CONTROL_INCOMPLETE_${changeType}`);
}

const failureCodes = new Set(model.failure_policy.map(({ error }) => error));
for (const code of ['FOREIGN_DATA_OWNER', 'TENANT_CONTEXT_MISMATCH', 'EVENT_REPLAY_NO_SIDE_EFFECT', 'SPLIT_EVIDENCE_INCOMPLETE']) {
  assert.ok(failureCodes.has(code), `FAILURE_POLICY_MISSING_${code}`);
}

console.log(
  `Service boundary operating model valid: ${modelContexts.length} contexts, ` +
  `${modelOwners.length} owner mappings, ${model.route_registry.length} API tags, ` +
  `${model.event_delivery.length} events, ${model.operational_flows.length} flows, ${modelGates.length} split gates`,
);

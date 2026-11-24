import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const governance = JSON.parse(await readFile(new URL('../docs/contracts/S01-W04.json', import.meta.url), 'utf8'));
const architecture = JSON.parse(await readFile(new URL('../docs/contracts/S01-W03.json', import.meta.url), 'utf8'));

const unique = (values, label) => assert.equal(new Set(values).size, values.length, `${label}_MUST_BE_UNIQUE`);
const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b));

assert.equal(governance.contract_id, 'S01-W04');
assert.equal(governance.version, '1.0.0');
assert.equal(governance.status, 'accepted_governance_contract');
assert.ok(governance.requirement_ids.includes('SEC-002'));
assert.equal(governance.legal_position.production_activation, 'DENY_UNTIL_ALL_EVIDENCE_APPROVED');
assert.match(governance.legal_position.notice, /does not replace legal advice/i);

const requiredDecisions = [
  'child_data_residency',
  'guardian_consent',
  'payment_gateway',
  'sms_provider',
  'object_storage',
  'attendance_device',
  'school_finance_integration',
];
const decisionIds = governance.decision_registry.map(({ id }) => id);
unique(decisionIds, 'DECISION_ID');
assert.deepEqual(sorted(decisionIds), sorted(requiredDecisions), 'DECISION_COVERAGE_MISMATCH');
for (const decision of governance.decision_registry) {
  assert.equal(decision.status, 'pending_evidence', `DECISION_MUST_REMAIN_OPEN_${decision.id}`);
  assert.equal(decision.activation_permitted, false, `PREMATURE_ACTIVATION_${decision.id}`);
  assert.ok(decision.decision_owner, `DECISION_OWNER_MISSING_${decision.id}`);
  assert.ok(decision.approvers.length >= 3, `MULTI_APPROVER_REQUIRED_${decision.id}`);
  assert.match(decision.planning_due_at, /^2026-12-(08|15)$/, `INVALID_PLANNING_DUE_DATE_${decision.id}`);
  assert.ok(decision.required_evidence.length >= 5, `DECISION_EVIDENCE_INCOMPLETE_${decision.id}`);
  assert.match(decision.failure_code, /_UNAPPROVED|_NOT_APPROVED$/, `FAILURE_CODE_REQUIRED_${decision.id}`);
}

assert.equal(governance.child_data_policy.classification, 'highly_sensitive');
assert.equal(governance.child_data_policy.tenant_scoped, true);
assert.equal(governance.child_data_policy.raw_biometric_template_in_saas, false);
assert.equal(governance.child_data_policy.public_file_url_allowed, false);
assert.equal(governance.child_data_policy.pii_in_logs_allowed, false);
assert.equal(governance.child_data_policy.processing_location_must_be_recorded, true);

const consentFields = new Set(governance.consent_contract.required_fields);
for (const field of [
  'tenant_id', 'student_person_id', 'guardian_person_id', 'verified_guardian_link_id',
  'purpose', 'scope', 'policy_version', 'notice_hash', 'granted_at', 'expires_at',
  'revoked_at', 'evidence_ref',
]) {
  assert.ok(consentFields.has(field), `CONSENT_FIELD_MISSING_${field}`);
}
assert.ok(governance.consent_contract.rules.includes('revocation_blocks_new_processing'));
assert.equal(governance.consent_contract.missing_or_invalid_error, 'CONSENT_REQUIRED');

const requiredProviders = ['payment_gateway', 'sms_provider', 'object_storage', 'attendance_device', 'school_finance_integration'];
const providerTypes = governance.provider_contracts.map(({ type }) => type);
unique(providerTypes, 'PROVIDER_TYPE');
assert.deepEqual(sorted(providerTypes), sorted(requiredProviders), 'PROVIDER_COVERAGE_MISMATCH');
for (const provider of governance.provider_contracts) {
  assert.equal(provider.credential_storage, 'secret_manager_reference_only', `INLINE_SECRET_RISK_${provider.type}`);
  assert.equal(provider.processing_location, 'TBD', `PROCESSING_LOCATION_MUST_REMAIN_TBD_${provider.type}`);
  assert.equal(provider.contract_status, 'unsigned', `CONTRACT_MUST_REMAIN_UNSIGNED_${provider.type}`);
  assert.equal(provider.poc_status, 'not_run', `POC_MUST_REMAIN_OPEN_${provider.type}`);
  assert.deepEqual(provider.budget, { status: 'unapproved', amount_minor: null, currency: 'IRR' });
  assert.ok(provider.activation_gates.includes('signed_contract'));
  assert.ok(provider.activation_gates.includes('approved_budget'));
  assert.ok(provider.allowed_data.length >= 4);
  assert.ok(provider.forbidden_data.length >= 3);
}
assert.ok(governance.provider_contracts.find(({ type }) => type === 'attendance_device').forbidden_data.includes('raw_biometric_template'));
assert.equal(governance.provider_contracts.find(({ type }) => type === 'school_finance_integration').mode, 'read_only_snapshot');

const architectureContexts = new Set(architecture.bounded_contexts.map(({ id }) => id));
const architectureOwners = new Set(architecture.table_ownership.map(({ owner }) => owner));
const tableNames = governance.table_ownership.map(({ table }) => table);
unique(tableNames, 'GOVERNANCE_TABLE');
for (const table of governance.table_ownership) {
  assert.ok(architectureContexts.has(table.context), `UNKNOWN_TABLE_CONTEXT_${table.table}`);
  assert.ok(architectureOwners.has(table.owner), `UNKNOWN_TABLE_OWNER_${table.table}`);
  assert.ok(table.scope && table.mutability, `TABLE_POLICY_INCOMPLETE_${table.table}`);
}

const operationIds = governance.api_contracts.map(({ operation_id }) => operation_id);
unique(operationIds, 'OPERATION_ID');
for (const operation of governance.api_contracts) {
  assert.match(operation.path, /^\/v1\//, `UNVERSIONED_API_${operation.operation_id}`);
  assert.ok(['GET', 'POST', 'PATCH', 'DELETE'].includes(operation.method));
  assert.ok(architectureContexts.has(operation.owner_context), `UNKNOWN_API_CONTEXT_${operation.operation_id}`);
  assert.equal(operation.implementation_state, 'contract_only_not_implemented');
}

const eventTypes = governance.event_contracts.map(({ type }) => type);
unique(eventTypes, 'EVENT_TYPE');
for (const event of governance.event_contracts) {
  assert.match(event.type, /\.v1$/, `UNVERSIONED_EVENT_${event.type}`);
  assert.ok(architectureContexts.has(event.producer), `UNKNOWN_EVENT_PRODUCER_${event.type}`);
  assert.ok(event.consumers.every((consumer) => architectureContexts.has(consumer)), `UNKNOWN_EVENT_CONSUMER_${event.type}`);
  assert.ok(event.dedupe_key, `EVENT_DEDUPE_KEY_MISSING_${event.type}`);
}

const actors = governance.permission_matrix.map(({ actor }) => actor);
unique(actors, 'PERMISSION_ACTOR');
for (const permission of governance.permission_matrix) {
  assert.ok(permission.allow.length >= 2, `ALLOW_MATRIX_INCOMPLETE_${permission.actor}`);
  assert.ok(permission.deny.length >= 3, `DENY_MATRIX_INCOMPLETE_${permission.actor}`);
}

assert.equal(governance.activation_policy.default, 'deny');
assert.equal(governance.activation_policy.all_decision_approvals_required, true);
assert.equal(governance.activation_policy.signed_contract_required, true);
assert.equal(governance.activation_policy.poc_required, true);
assert.equal(governance.activation_policy.processing_location_required, true);
assert.equal(governance.activation_policy.approved_budget_required, true);
assert.equal(governance.activation_policy.secret_reference_required, true);
assert.equal(governance.acceptance_scenarios.length, 8);
assert.equal(governance.acceptance_scenarios.filter(({ expected }) => expected === 'rejected').length, 7);

console.log(
  `Provider governance contract valid: ${decisionIds.length} decisions, ` +
  `${providerTypes.length} provider types, ${tableNames.length} tables, ` +
  `${operationIds.length} API operations, ${eventTypes.length} events, ${actors.length} actors`,
);

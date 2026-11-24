import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = JSON.parse(await readFile(path.join(root, "docs/contracts/S01-W04.json"), "utf8"));
const workflow = JSON.parse(await readFile(path.join(root, "docs/decisions/provider-approval-workflow.v1.json"), "utf8"));

assert.equal(workflow.schema_version, "1.0");
assert.equal(workflow.workflow_id, "S01-W04-T02");
assert.equal(workflow.version, "1.0.0");
assert.equal(workflow.status, "accepted_operating_model");
assert.deepEqual(workflow.requirement_ids, ["SEC-002"]);
assert.equal(workflow.source_contract.contract_id, contract.contract_id);
assert.equal(workflow.source_contract.version, contract.version);

assert.equal(workflow.safety_boundary.default, "deny");
assert.equal(workflow.safety_boundary.external_legal_decisions_complete, false);
assert.equal(workflow.safety_boundary.provider_selection_complete, false);
assert.equal(workflow.safety_boundary.production_activation_permitted, false);
assert.equal(workflow.safety_boundary.stable_error, contract.activation_policy.stable_error);

const states = new Set(workflow.state_model.states);
assert(states.has(workflow.state_model.initial_state));
for (const transition of workflow.state_model.transitions) {
  assert(states.has(transition.from), `unknown from state: ${transition.from}`);
  assert(states.has(transition.to), `unknown to state: ${transition.to}`);
  assert(transition.actor && transition.gate);
}
assert(!workflow.state_model.transitions.some(({ from, to }) => from === "evidence_collecting" && to === "activated"));
const activate = workflow.state_model.transitions.filter(({ to }) => to === "activated");
assert.equal(activate.length, 1);
assert.equal(activate[0].from, "activation_requested");
assert.equal(activate[0].gate, "separate_production_change_approved");

assert.equal(workflow.evidence_policy.repository_content, "metadata_and_hash_only");
assert(workflow.evidence_policy.required_metadata.includes("sha256"));
assert(workflow.evidence_policy.forbidden_content.includes("child_pii"));
assert(workflow.evidence_policy.forbidden_content.includes("provider_secret"));
assert.equal(workflow.evidence_policy.expired_evidence_blocks_activation, true);
assert.equal(workflow.approval_policy.all_configured_approvers_required, true);
assert.equal(workflow.approval_policy.minimum_distinct_approver_roles, 3);
assert.equal(workflow.approval_policy.evidence_change_invalidates_approvals, true);

const contractCases = new Map(contract.decision_registry.map((item) => [item.id, item]));
const workflowCases = new Map(workflow.decision_cases.map((item) => [item.id, item]));
assert.equal(contractCases.size, 7);
assert.equal(workflowCases.size, contractCases.size);
assert.equal(workflow.decision_cases.filter(({ case_type }) => case_type === "provider").length, 5);

for (const [id, expected] of contractCases) {
  const actual = workflowCases.get(id);
  assert(actual, `missing decision case: ${id}`);
  assert.equal(actual.decision_owner, expected.decision_owner, `${id}: owner mismatch`);
  assert.deepEqual(actual.approvers, expected.approvers, `${id}: approvers mismatch`);
  assert.equal(new Set(actual.approvers).size, 3, `${id}: approvers must be distinct`);
  assert.equal(actual.planning_due_at, expected.planning_due_at, `${id}: due date mismatch`);
  assert.deepEqual(actual.required_evidence, expected.required_evidence, `${id}: evidence mismatch`);
  assert.equal(actual.state, "evidence_collecting", `${id}: unsafe initial state`);
  assert.equal(actual.activation_permitted, false, `${id}: activation must be denied`);
  assert.equal(actual.failure_code, expected.failure_code, `${id}: failure code mismatch`);
}

const privacyCases = workflow.decision_cases.filter(({ case_type }) => case_type === "privacy");
assert.equal(privacyCases.length, 2);
for (const item of privacyCases) {
  assert(item.external_value, `${item.id}: external value record missing`);
  assert.equal(item.external_value.effective_at, null, `${item.id}: unresolved decision must have no effective date`);
}
assert.equal(workflowCases.get("child_data_residency").external_value.jurisdiction, null);
assert.equal(workflowCases.get("child_data_residency").external_value.legal_basis, null);
assert.equal(workflowCases.get("child_data_residency").external_value.cross_border_transfer_approved, false);
assert.equal(workflowCases.get("guardian_consent").external_value.policy_version, null);
assert.equal(workflowCases.get("guardian_consent").external_value.notice_hash, null);

const contractProviders = new Map(contract.provider_contracts.map((item) => [item.type, item]));
const workflowProviders = new Map(workflow.provider_records.map((item) => [item.type, item]));
assert.equal(contractProviders.size, 5);
assert.equal(workflowProviders.size, contractProviders.size);

for (const [type, expected] of contractProviders) {
  const actual = workflowProviders.get(type);
  assert(actual, `missing provider record: ${type}`);
  assert.equal(actual.decision_id, type);
  assert.equal(workflowCases.get(type).provider_record_id, actual.id);
  assert.equal(actual.contract.status, expected.contract_status);
  assert.equal(actual.contract.opaque_reference, null);
  assert.equal(actual.budget.status, expected.budget.status);
  assert.equal(actual.budget.owner, "finance_owner");
  assert.equal(actual.budget.amount_minor, null);
  assert.equal(actual.budget.currency, expected.budget.currency);
  assert.equal(actual.poc.status, expected.poc_status);
  assert.equal(actual.poc.environment, "sandbox");
  assert.equal(actual.processing_location, expected.processing_location);
  assert.equal(actual.secret_reference, null);
  assert.equal(actual.activation.status, "denied");
  assert.equal(actual.activation.change_reference, null);
  assert.equal(actual.activation.activated_at, null);
}

assert.equal(workflow.operational_steps.length, 8);
assert.deepEqual(workflow.operational_steps.map(({ order }) => order), [1, 2, 3, 4, 5, 6, 7, 8]);
assert.equal(workflow.deadline_policy.deadline_is_not_automatic_approval, true);
assert.equal(workflow.deadline_policy.overdue_action, "remain_denied_and_escalate_to_decision_owner");
assert.equal(workflow.audit_policy.pii_in_audit_log_allowed, false);
assert.equal(workflow.audit_policy.secret_in_audit_log_allowed, false);
assert(workflow.audit_policy.required_fields.includes("decision_version"));

console.log(
  `Provider approval workflow valid: ${workflowCases.size} cases, ${workflowProviders.size} providers, ` +
  `${workflow.state_model.states.length} states, ${workflow.state_model.transitions.length} transitions, ` +
  `${workflow.operational_steps.length} operational steps`
);

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const contract = JSON.parse(await readFile(path.join(root, "docs/contracts/S01-W04.json"), "utf8"));
const workflow = JSON.parse(await readFile(path.join(root, "docs/decisions/provider-approval-workflow.v1.json"), "utf8"));

const cases = new Map(workflow.decision_cases.map((item) => [item.id, item]));
const providers = new Map(workflow.provider_records.map((item) => [item.type, item]));
const fixedNow = new Date("2026-11-24T06:05:00Z");

class BoundaryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function deny(code) {
  throw new BoundaryError(code);
}

function expectCode(fn, code) {
  assert.throws(fn, (error) => error instanceof BoundaryError && error.code === code);
}

function clone(value) {
  return structuredClone(value);
}

function completeEvidence(decisionId, tenantId = "tenant-alpha") {
  const decision = cases.get(decisionId);
  assert(decision, `unknown decision: ${decisionId}`);
  return decision.required_evidence.map((evidenceType, index) => ({
    evidence_type: evidenceType,
    opaque_reference: `evidence://${tenantId}/${decisionId}/${index + 1}`,
    sha256: createHash("sha256").update(`${tenantId}:${decisionId}:${evidenceType}`).digest("hex"),
    issued_at: "2026-11-24T00:00:00Z",
    expires_at: "2026-12-31T23:59:59Z",
    submitted_by: "actor:decision-owner",
    classification: "confidential",
    payload_kind: "metadata_only"
  }));
}

function validateEvidence({ decisionId, resourceTenantId, actorTenantId, evidence }) {
  if (resourceTenantId !== actorTenantId) deny("TENANT_CONTEXT_MISMATCH");
  const decision = cases.get(decisionId);
  if (!decision) deny("DECISION_NOT_FOUND");

  const byType = new Map(evidence.map((item) => [item.evidence_type, item]));
  for (const required of decision.required_evidence) {
    if (!byType.has(required)) deny("EVIDENCE_INCOMPLETE");
  }

  for (const item of evidence) {
    for (const field of workflow.evidence_policy.required_metadata) {
      if (item[field] === undefined || item[field] === null || item[field] === "") {
        deny("EVIDENCE_METADATA_INVALID");
      }
    }
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) deny("EVIDENCE_HASH_INVALID");
    if (workflow.evidence_policy.forbidden_content.includes(item.payload_kind)) {
      deny("EVIDENCE_CONTENT_FORBIDDEN");
    }
    if (new Date(item.expires_at) <= fixedNow) deny("EVIDENCE_EXPIRED");
  }

  const manifestHash = createHash("sha256")
    .update(
      evidence
        .map(({ evidence_type, sha256 }) => `${evidence_type}:${sha256}`)
        .sort()
        .join("|")
    )
    .digest("hex");

  return { manifestHash, state: "ready_for_review" };
}

function completeApprovals(decisionId, manifestHash) {
  const decision = cases.get(decisionId);
  return decision.approvers.map((role, index) => ({
    decision_id: decisionId,
    decision_version: workflow.version,
    approver_role: role,
    actor_id: `actor:${role}:${index + 1}`,
    evidence_manifest_hash: manifestHash,
    approved_at: "2026-11-24T06:00:00Z",
    expires_at: "2026-12-31T23:59:59Z",
    comment_ref: `comment://${decisionId}/${index + 1}`
  }));
}

function validateApprovals(decisionId, manifestHash, approvals) {
  const decision = cases.get(decisionId);
  const roles = new Set();
  const actors = new Set();

  for (const approval of approvals) {
    if (approval.decision_id !== decisionId || approval.decision_version !== workflow.version) {
      deny("APPROVAL_VERSION_MISMATCH");
    }
    if (approval.evidence_manifest_hash !== manifestHash) deny("APPROVALS_STALE");
    if (!decision.approvers.includes(approval.approver_role)) deny("APPROVER_ROLE_NOT_CONFIGURED");
    if (actors.has(approval.actor_id)) deny("APPROVER_ACTOR_REUSED");
    roles.add(approval.approver_role);
    actors.add(approval.actor_id);
  }

  if (roles.size !== decision.approvers.length) deny("APPROVALS_INCOMPLETE");
  for (const role of decision.approvers) {
    if (!roles.has(role)) deny("APPROVALS_INCOMPLETE");
  }
  return { state: "approved" };
}

function evaluateProvider({
  type,
  manifestHash,
  approvals,
  requestedDataKinds = [],
  requestedMode = null,
  directActivation = false,
  productionChangeReference = null
}) {
  const provider = providers.get(type);
  if (!provider) deny("PROVIDER_NOT_FOUND");
  const decision = cases.get(provider.decision_id);

  validateApprovals(decision.id, manifestHash, approvals);
  if (provider.contract.status !== "signed" || !provider.contract.opaque_reference) {
    deny("PROVIDER_CONTRACT_NOT_APPROVED");
  }
  if (provider.budget.status !== "approved" || !Number.isSafeInteger(provider.budget.amount_minor) || provider.budget.amount_minor <= 0) {
    deny("BUDGET_NOT_APPROVED");
  }
  if (provider.poc.status !== "passed" || !provider.poc.evidence_ref) deny("PROVIDER_POC_NOT_APPROVED");
  if (!provider.processing_location || provider.processing_location === "TBD") deny("PROCESSING_LOCATION_UNAPPROVED");
  if (!provider.secret_reference?.startsWith("secret://")) deny("PROVIDER_SECRET_REFERENCE_REQUIRED");
  if (type === "attendance_device" && requestedDataKinds.some((item) => ["raw_biometric_template", "biometric_image"].includes(item))) {
    deny("RAW_BIOMETRIC_TEMPLATE_FORBIDDEN");
  }
  if (type === "school_finance_integration" && requestedMode !== "read_only_snapshot") {
    deny("FINANCE_WRITE_NOT_APPROVED");
  }
  if (directActivation && !productionChangeReference) deny("PRODUCTION_CHANGE_APPROVAL_REQUIRED");

  return {
    state: "activation_requested",
    activation_permitted: false,
    production_change_required: true
  };
}

function approvedProvider(type) {
  const provider = clone(providers.get(type));
  provider.contract = {
    status: "signed",
    opaque_reference: `contract://${type}/v1`,
    signed_at: "2026-11-24T00:00:00Z",
    expires_at: "2027-11-24T00:00:00Z"
  };
  provider.budget = {
    status: "approved",
    owner: "finance_owner",
    amount_minor: 1000000,
    currency: "IRR",
    period: "monthly"
  };
  provider.poc = { status: "passed", environment: "sandbox", evidence_ref: `evidence://poc/${type}` };
  provider.processing_location = "IR-APPROVED-REGION";
  provider.secret_reference = `secret://providers/${type}/v1`;
  return provider;
}

function withProvider(type, replacement, fn) {
  const original = providers.get(type);
  providers.set(type, replacement);
  try {
    return fn();
  } finally {
    providers.set(type, original);
  }
}

test("fixtures remain aligned with the accepted workflow", () => {
  assert.equal(contract.decision_registry.length, 7);
  assert.equal(workflow.decision_cases.length, 7);
  assert.equal(workflow.provider_records.length, 5);
  assert.equal(workflow.safety_boundary.production_activation_permitted, false);
});

test("tenant beta cannot submit evidence to tenant alpha case", () => {
  expectCode(
    () => validateEvidence({ decisionId: "guardian_consent", resourceTenantId: "tenant-alpha", actorTenantId: "tenant-beta", evidence: completeEvidence("guardian_consent") }),
    "TENANT_CONTEXT_MISMATCH"
  );
});

test("missing evidence blocks review", () => {
  const evidence = completeEvidence("child_data_residency").slice(1);
  expectCode(
    () => validateEvidence({ decisionId: "child_data_residency", resourceTenantId: "tenant-alpha", actorTenantId: "tenant-alpha", evidence }),
    "EVIDENCE_INCOMPLETE"
  );
});

test("raw secret or PII evidence content is rejected", () => {
  const evidence = completeEvidence("sms_provider");
  evidence[0].payload_kind = "provider_secret";
  expectCode(
    () => validateEvidence({ decisionId: "sms_provider", resourceTenantId: "tenant-alpha", actorTenantId: "tenant-alpha", evidence }),
    "EVIDENCE_CONTENT_FORBIDDEN"
  );
});

test("expired evidence blocks review", () => {
  const evidence = completeEvidence("object_storage");
  evidence[0].expires_at = "2026-11-23T00:00:00Z";
  expectCode(
    () => validateEvidence({ decisionId: "object_storage", resourceTenantId: "tenant-alpha", actorTenantId: "tenant-alpha", evidence }),
    "EVIDENCE_EXPIRED"
  );
});

test("one actor cannot impersonate three approver roles", () => {
  const { manifestHash } = validateEvidence({ decisionId: "payment_gateway", resourceTenantId: "tenant-alpha", actorTenantId: "tenant-alpha", evidence: completeEvidence("payment_gateway") });
  const approvals = completeApprovals("payment_gateway", manifestHash).map((item) => ({ ...item, actor_id: "actor:one-person" }));
  expectCode(() => validateApprovals("payment_gateway", manifestHash, approvals), "APPROVER_ACTOR_REUSED");
});

test("approval for a previous evidence manifest is stale", () => {
  const { manifestHash } = validateEvidence({ decisionId: "sms_provider", resourceTenantId: "tenant-alpha", actorTenantId: "tenant-alpha", evidence: completeEvidence("sms_provider") });
  const approvals = completeApprovals("sms_provider", "f".repeat(64));
  expectCode(() => validateApprovals("sms_provider", manifestHash, approvals), "APPROVALS_STALE");
});

test("unsigned contract blocks provider eligibility", () => {
  const { manifestHash } = validateEvidence({ decisionId: "payment_gateway", resourceTenantId: "tenant-alpha", actorTenantId: "tenant-alpha", evidence: completeEvidence("payment_gateway") });
  expectCode(() => evaluateProvider({ type: "payment_gateway", manifestHash, approvals: completeApprovals("payment_gateway", manifestHash) }), "PROVIDER_CONTRACT_NOT_APPROVED");
});

test("unapproved budget blocks provider eligibility", () => {
  const type = "object_storage";
  const provider = approvedProvider(type);
  provider.budget.status = "unapproved";
  provider.budget.amount_minor = null;
  const { manifestHash } = validateEvidence({ decisionId: type, resourceTenantId: "tenant-alpha", actorTenantId: "tenant-alpha", evidence: completeEvidence(type) });
  expectCode(() => withProvider(type, provider, () => evaluateProvider({ type, manifestHash, approvals: completeApprovals(type, manifestHash) })), "BUDGET_NOT_APPROVED");
});

test("missing processing location and secret reference remain fail-closed", () => {
  const type = "sms_provider";
  const provider = approvedProvider(type);
  provider.processing_location = "TBD";
  const { manifestHash } = validateEvidence({ decisionId: type, resourceTenantId: "tenant-alpha", actorTenantId: "tenant-alpha", evidence: completeEvidence(type) });
  expectCode(() => withProvider(type, provider, () => evaluateProvider({ type, manifestHash, approvals: completeApprovals(type, manifestHash) })), "PROCESSING_LOCATION_UNAPPROVED");
  provider.processing_location = "IR-APPROVED-REGION";
  provider.secret_reference = null;
  expectCode(() => withProvider(type, provider, () => evaluateProvider({ type, manifestHash, approvals: completeApprovals(type, manifestHash) })), "PROVIDER_SECRET_REFERENCE_REQUIRED");
});

test("attendance device can never upload raw biometric material", () => {
  const type = "attendance_device";
  const provider = approvedProvider(type);
  const { manifestHash } = validateEvidence({ decisionId: type, resourceTenantId: "tenant-alpha", actorTenantId: "tenant-alpha", evidence: completeEvidence(type) });
  expectCode(
    () => withProvider(type, provider, () => evaluateProvider({ type, manifestHash, approvals: completeApprovals(type, manifestHash), requestedDataKinds: ["raw_biometric_template"] })),
    "RAW_BIOMETRIC_TEMPLATE_FORBIDDEN"
  );
});

test("school finance integration rejects every write mode", () => {
  const type = "school_finance_integration";
  const provider = approvedProvider(type);
  const { manifestHash } = validateEvidence({ decisionId: type, resourceTenantId: "tenant-alpha", actorTenantId: "tenant-alpha", evidence: completeEvidence(type) });
  expectCode(
    () => withProvider(type, provider, () => evaluateProvider({ type, manifestHash, approvals: completeApprovals(type, manifestHash), requestedMode: "write_balance" })),
    "FINANCE_WRITE_NOT_APPROVED"
  );
});

test("verified guardian relation is tenant scoped", () => {
  const consent = { tenant_id: "tenant-alpha", verified_guardian_link_id: "link-alpha", revoked_at: null };
  const request = { tenant_id: "tenant-beta", verified_guardian_link_id: "link-alpha" };
  expectCode(() => {
    if (consent.tenant_id !== request.tenant_id || consent.verified_guardian_link_id !== request.verified_guardian_link_id) deny("CONSENT_REQUIRED");
  }, "CONSENT_REQUIRED");
});

test("complete synthetic gates stop at activation_requested", () => {
  const type = "payment_gateway";
  const provider = approvedProvider(type);
  const evidence = completeEvidence(type);
  const { manifestHash } = validateEvidence({ decisionId: type, resourceTenantId: "tenant-alpha", actorTenantId: "tenant-alpha", evidence });
  const approvals = completeApprovals(type, manifestHash);
  const result = withProvider(type, provider, () => evaluateProvider({ type, manifestHash, approvals }));
  assert.deepEqual(result, { state: "activation_requested", activation_permitted: false, production_change_required: true });
  expectCode(
    () => withProvider(type, provider, () => evaluateProvider({ type, manifestHash, approvals, directActivation: true })),
    "PRODUCTION_CHANGE_APPROVAL_REQUIRED"
  );
});

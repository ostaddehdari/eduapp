import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const contractUrl = new URL('../docs/contracts/S01-W02.json', import.meta.url);
const markdownUrl = new URL('../docs/contracts/S01-W02.md', import.meta.url);
const openapiUrl = new URL('../preview/api/openapi.json', import.meta.url);

const contract = JSON.parse(await readFile(contractUrl, 'utf8'));
const markdown = await readFile(markdownUrl, 'utf8');
const openapi = JSON.parse(await readFile(openapiUrl, 'utf8'));

assert.equal(contract.contract_id, 'S01-W02');
assert.match(contract.version, /^\d+\.\d+\.\d+$/);
assert.equal(contract.status, 'accepted');
assert.ok(contract.requirement_ids.includes('FR-003'));
assert.ok(markdown.includes('نسخه: `1.0.0`'));

const expectedStates = [
  'PLAN_SELECTED',
  'BUYER_AUTHENTICATED',
  'CHECKOUT_CREATED',
  'PAYMENT_PENDING',
  'PAYMENT_VERIFIED',
  'TENANT_ACTIVE',
  'FIRST_ORG_CREATED',
  'FIRST_SCHOOL_CREATED',
  'ONBOARDING_COMPLETE',
];
assert.deepEqual(contract.journey.states, expectedStates);
assert.equal(contract.journey.steps.length, 8);
assert.deepEqual(contract.journey.steps.map((step) => step.order), [1, 2, 3, 4, 5, 6, 7, 8]);

const operationIds = new Set();
for (const [path, pathItem] of Object.entries(openapi.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
      operationIds.add(`${method.toUpperCase()} ${path} ${operation.operationId}`);
    }
  }
}

for (const api of contract.api_contracts) {
  assert.ok(api.owner, `missing owner for ${api.operation_id}`);
  assert.ok(api.actor, `missing actor for ${api.operation_id}`);
  assert.ok(api.auth, `missing auth for ${api.operation_id}`);
  assert.ok(api.idempotency, `missing idempotency for ${api.operation_id}`);
  assert.ok(operationIds.has(`${api.method} ${api.path} ${api.operation_id}`), `OpenAPI operation missing: ${api.operation_id}`);
}

const tableOwners = new Map();
for (const domain of contract.data_ownership) {
  for (const table of domain.tables) {
    assert.equal(tableOwners.has(table), false, `table has multiple owners: ${table}`);
    tableOwners.set(table, domain.owner);
  }
}
assert.equal(tableOwners.get('subscriptions'), 'billing');
assert.equal(tableOwners.get('tenants'), 'tenancy');
assert.equal(tableOwners.get('org_units'), 'tenancy');
assert.equal(tableOwners.get('schools'), 'school');

const permissions = new Map(contract.permission_matrix.map((row) => [row.actor, row]));
assert.deepEqual(permissions.get('visitor').allow, ['listPlans']);
assert.ok(permissions.get('visitor').deny.includes('createTenant'));
assert.ok(permissions.get('authenticated_buyer').deny.includes('createTenant'));
assert.deepEqual(permissions.get('payment_provider').allow, ['receivePaymentWebhook']);
assert.deepEqual(permissions.get('provisioning_service').allow, ['createTenant']);
assert.ok(permissions.get('tenant_owner').allow.includes('createOrgUnit'));
assert.ok(permissions.get('tenant_owner').allow.includes('createSchool'));

const eventTypes = new Set(contract.events.map((event) => event.type));
for (const required of [
  'billing.payment_verified.v1',
  'billing.subscription_activated.v1',
  'tenancy.tenant_created.v1',
  'tenancy.org_unit_created.v1',
  'school.school_created.v1',
  'onboarding.completed.v1',
]) assert.ok(eventTypes.has(required), `missing event ${required}`);
assert.ok(contract.events.every((event) => event.dedupe_key && event.contains_pii === false));

const scenarios = new Map(contract.acceptance_scenarios.map((scenario) => [scenario.id, scenario]));
assert.equal(scenarios.get('happy-independent-school').expected, 'accepted');
assert.equal(scenarios.get('happy-branched-school').expected, 'accepted');
assert.equal(scenarios.get('duplicate-payment-event').expected, 'deduplicated');
assert.equal(scenarios.get('unverified-payment-callback').error, 'PAYMENT_NOT_VERIFIED');
assert.equal(scenarios.get('cross-tenant-parent').error, 'ORG_PARENT_NOT_FOUND');
assert.equal(scenarios.get('org-cycle').error, 'ORG_CYCLE');
assert.equal(scenarios.get('duplicate-sibling-code').error, 'ORG_CODE_CONFLICT');
assert.equal(scenarios.get('school-org-other-tenant').error, 'ORG_UNIT_NOT_FOUND');

for (const invariant of [
  'tenant_creation_requires_verified_payment_or_platform_admin',
  'billing_never_writes_tenants_or_org_units',
  'org_parent_must_belong_to_same_tenant',
  'org_tree_must_be_acyclic',
  'event_consumers_must_dedupe_before_side_effect',
]) assert.ok(contract.invariants.includes(invariant), `missing invariant ${invariant}`);

console.log(`Commercial journey contract valid: ${contract.api_contracts.length} APIs, ${contract.events.length} events, ${tableOwners.size} owned tables, ${contract.acceptance_scenarios.length} scenarios`);

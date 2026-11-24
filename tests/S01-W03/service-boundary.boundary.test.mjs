import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { DomainError, ServiceBoundaryHarness } from './support/service-boundary-harness.mjs';

const contract = JSON.parse(await readFile(new URL('../../docs/contracts/S01-W03.json', import.meta.url), 'utf8'));
const model = JSON.parse(await readFile(new URL('../../docs/architecture/service-boundary-operating-model.v1.json', import.meta.url), 'utf8'));
const expectCode = (code) => (error) => error instanceof DomainError && error.code === code;
const createHarness = () => new ServiceBoundaryHarness({ contract, model });

test('هر ده context و همه مالک‌های داده به مسیر اجرایی مشخص متصل‌اند', () => {
  const harness = createHarness();
  const contractContexts = contract.bounded_contexts.map(({ id }) => id).sort();
  const operationalContexts = [...harness.contexts.keys()].sort();
  const contractOwners = contract.table_ownership.map(({ owner }) => owner).sort();
  const operationalOwners = [...harness.owners.keys()].sort();

  assert.deepEqual(operationalContexts, contractContexts);
  assert.deepEqual(operationalOwners, contractOwners);
  assert.equal(model.runtime_topology.length, 4);
  assert.equal(model.split_decision.automatic_split, false);
});

test('connection pool بین Tenant اول و دوم reset می‌شود و داده نشت نمی‌کند', () => {
  const harness = createHarness();
  harness.grantMembership('identity-shared', 'tenant-a');
  harness.grantMembership('identity-shared', 'tenant-b');

  const firstBinding = harness.bindTenant({ identityId: 'identity-shared', tenantId: 'tenant-a' });
  harness.writeOwnedRecord({
    callerContext: 'people_fields', targetContext: 'people_fields', recordId: 'person-1', value: 'Tenant A',
  });

  const secondBinding = harness.bindTenant({ identityId: 'identity-shared', tenantId: 'tenant-b' });
  assert.ok(secondBinding.epoch > firstBinding.epoch);
  assert.throws(
    () => harness.readOwnedRecord({ context: 'people_fields', recordId: 'person-1' }),
    expectCode('OWNED_RECORD_NOT_FOUND'),
  );

  harness.writeOwnedRecord({
    callerContext: 'people_fields', targetContext: 'people_fields', recordId: 'person-1', value: 'Tenant B',
  });
  assert.equal(harness.readOwnedRecord({ context: 'people_fields', recordId: 'person-1' }).value, 'Tenant B');
  assert.equal(harness.snapshot().records, 2);
});

test('عضویت نامعتبر fail-closed است و اتصال Tenant قبلی را باقی نمی‌گذارد', () => {
  const harness = createHarness();
  harness.grantMembership('identity-1', 'tenant-a');
  harness.bindTenant({ identityId: 'identity-1', tenantId: 'tenant-a' });

  assert.throws(
    () => harness.bindTenant({ identityId: 'identity-1', tenantId: 'tenant-c' }),
    expectCode('TENANT_CONTEXT_MISMATCH'),
  );
  assert.equal(harness.snapshot().boundTenant, null);
  assert.throws(
    () => harness.writeOwnedRecord({
      callerContext: 'people_fields', targetContext: 'people_fields', recordId: 'person-2', value: 'forbidden',
    }),
    expectCode('TENANT_CONTEXT_NOT_BOUND'),
  );
});

test('context مالک نمی‌تواند جدول context دیگر را مستقیم بنویسد', () => {
  const harness = createHarness();
  harness.grantMembership('identity-1', 'tenant-a');
  harness.bindTenant({ identityId: 'identity-1', tenantId: 'tenant-a' });
  const before = harness.snapshot();

  assert.throws(
    () => harness.writeOwnedRecord({
      callerContext: 'school_enrollment', targetContext: 'attendance', recordId: 'attendance-1', value: 'present',
    }),
    expectCode('FOREIGN_DATA_OWNER'),
  );
  assert.deepEqual(harness.snapshot(), before);
});

test('پنج replay فرمان مالی فقط یک ledger و یک outbox event می‌سازد', () => {
  const harness = createHarness();
  harness.grantMembership('payer-1', 'tenant-a');
  harness.bindTenant({ identityId: 'payer-1', tenantId: 'tenant-a' });
  const command = {
    idempotencyKey: 'checkout-1',
    payload: { amountMinor: 500000, subscriptionId: 'subscription-1' },
  };
  const results = Array.from({ length: 5 }, () => harness.executeFinancialCommand(command));

  assert.equal(new Set(results.map(({ ledgerId }) => ledgerId)).size, 1);
  assert.equal(results.filter(({ deduplicated }) => deduplicated).length, 4);
  assert.equal(harness.snapshot().ledgerEntries, 1);
  assert.equal(harness.snapshot().outboxEvents, 1);
  assert.throws(
    () => harness.executeFinancialCommand({
      idempotencyKey: 'checkout-1', payload: { amountMinor: 700000, subscriptionId: 'subscription-1' },
    }),
    expectCode('IDEMPOTENCY_PAYLOAD_MISMATCH'),
  );
});

test('پنج تحویل یک رویداد فقط یک side effect برای consumer دارد', () => {
  const harness = createHarness();
  const delivery = {
    consumer: 'notifications_integrations',
    eventId: 'event-enrollment-1',
    type: 'school.enrollment_changed.v1',
    payload: { tenantId: 'tenant-a', enrollmentId: 'enrollment-1', version: 1 },
  };
  const results = Array.from({ length: 5 }, () => harness.deliverEvent(delivery));

  assert.equal(results.filter(({ sideEffectApplied }) => sideEffectApplied).length, 1);
  assert.equal(results.filter(({ deduplicated }) => deduplicated).length, 4);
  assert.equal(harness.snapshot().inboxEntries, 1);
  assert.equal(harness.snapshot().eventEffects, 1);
});

test('split ناقص رد می‌شود و شواهد کامل فقط اجازه ADR review می‌دهد', () => {
  const harness = createHarness();
  assert.throws(
    () => harness.evaluateSplit(['contract_readiness', 'cost_review', 'measured_pressure']),
    expectCode('SPLIT_EVIDENCE_INCOMPLETE'),
  );
  assert.throws(
    () => harness.evaluateSplit(['contract_readiness', 'data_migration_readiness', 'cost_review']),
    expectCode('SPLIT_EVIDENCE_INCOMPLETE'),
  );

  const decision = harness.evaluateSplit([
    'contract_readiness', 'data_migration_readiness', 'cost_review', 'measured_pressure',
  ]);
  assert.deepEqual(decision, {
    result: 'eligible_for_reviewed_adr_not_automatic_split',
    automaticSplit: false,
    nextState: 'reviewed',
  });
});

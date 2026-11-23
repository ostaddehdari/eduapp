import assert from 'node:assert/strict';
import test from 'node:test';

import { CommercialJourneyHarness, DomainError } from './support/commercial-journey-harness.mjs';

const expectCode = (code) => (error) => error instanceof DomainError && error.code === code;

function paidTenant(harness, suffix) {
  return harness.verifyAndProvisionPayment({
    provider: 'sandbox',
    providerEventId: `event-${suffix}`,
    verified: true,
    subscriptionId: `subscription-${suffix}`,
    ownerIdentityId: `owner-${suffix}`
  }).tenantId;
}

test('مدرسه مستقل پس از پرداخت تأییدشده در Tenant خودش ساخته می‌شود', () => {
  const harness = new CommercialJourneyHarness();
  const tenantId = paidTenant(harness, 'independent');
  const root = harness.createOrgUnit({ actorTenantId: tenantId, code: 'school-1', kind: 'school' });
  const school = harness.createSchool({ actorTenantId: tenantId, orgUnitId: root.id, name: 'مدرسه مستقل' });

  assert.equal(root.parentId, null);
  assert.equal(root.tenantId, tenantId);
  assert.equal(school.tenantId, tenantId);
  assert.equal(school.orgUnitId, root.id);
  assert.deepEqual(harness.snapshot(), {
    providerEvents: 1, subscriptions: 1, ledgerEntries: 1, entitlements: 1,
    tenants: 1, orgUnits: 1, schools: 1
  });
});

test('مدرسه شعبه‌ای با مجموعه و شعبه هم‌Tenant ساخته می‌شود', () => {
  const harness = new CommercialJourneyHarness();
  const tenantId = paidTenant(harness, 'branched');
  const collection = harness.createOrgUnit({ actorTenantId: tenantId, code: 'group', kind: 'collection' });
  const branch = harness.createOrgUnit({ actorTenantId: tenantId, parentId: collection.id, code: 'north', kind: 'branch' });
  const school = harness.createSchool({ actorTenantId: tenantId, orgUnitId: branch.id, name: 'شعبه شمال' });

  assert.equal(branch.parentId, collection.id);
  assert.equal(branch.tenantId, tenantId);
  assert.equal(school.tenantId, tenantId);
});

test('پنج تحویل رویداد پرداخت فقط یک اثر مالی و یک Tenant ایجاد می‌کند', () => {
  const harness = new CommercialJourneyHarness();
  const results = Array.from({ length: 5 }, () => harness.verifyAndProvisionPayment({
    provider: 'sandbox', providerEventId: 'event-replay', verified: true,
    subscriptionId: 'subscription-replay', ownerIdentityId: 'owner-replay'
  }));

  assert.equal(new Set(results.map((item) => item.tenantId)).size, 1);
  assert.equal(results.filter((item) => item.deduplicated).length, 4);
  assert.deepEqual(harness.snapshot(), {
    providerEvents: 1, subscriptions: 1, ledgerEntries: 1, entitlements: 1,
    tenants: 1, orgUnits: 0, schools: 0
  });
});

test('callback تأییدنشده هیچ اثر مالی یا Tenant ایجاد نمی‌کند', () => {
  const harness = new CommercialJourneyHarness();
  assert.throws(() => harness.verifyAndProvisionPayment({
    provider: 'sandbox', providerEventId: 'event-forged', verified: false,
    subscriptionId: 'subscription-forged', ownerIdentityId: 'owner-forged'
  }), expectCode('PAYMENT_NOT_VERIFIED'));

  assert.deepEqual(harness.snapshot(), {
    providerEvents: 0, subscriptions: 0, ledgerEntries: 0, entitlements: 0,
    tenants: 0, orgUnits: 0, schools: 0
  });
});

test('Tenant دوم نمی‌تواند parent یا school scope Tenant اول را استفاده کند', () => {
  const harness = new CommercialJourneyHarness();
  const tenantA = paidTenant(harness, 'a');
  const tenantB = paidTenant(harness, 'b');
  const rootA = harness.createOrgUnit({ actorTenantId: tenantA, code: 'root', kind: 'collection' });
  const before = harness.snapshot();

  assert.throws(() => harness.createOrgUnit({
    actorTenantId: tenantB, parentId: rootA.id, code: 'stolen-child', kind: 'branch'
  }), expectCode('ORG_PARENT_NOT_FOUND'));
  assert.throws(() => harness.createSchool({
    actorTenantId: tenantB, orgUnitId: rootA.id, name: 'مدرسه نامعتبر'
  }), expectCode('ORG_UNIT_NOT_FOUND'));

  assert.deepEqual(harness.snapshot(), before);
  assert.equal(harness.tenants.size, 2);
});

test('چرخه و کد sibling تکراری رد می‌شوند و درخت تغییر نمی‌کند', () => {
  const harness = new CommercialJourneyHarness();
  const tenantId = paidTenant(harness, 'integrity');
  const root = harness.createOrgUnit({ actorTenantId: tenantId, code: 'root', kind: 'collection' });
  const branch = harness.createOrgUnit({ actorTenantId: tenantId, parentId: root.id, code: 'north', kind: 'branch' });
  const before = harness.snapshot();

  assert.throws(() => harness.createOrgUnit({
    actorTenantId: tenantId, parentId: root.id, code: ' NORTH ', kind: 'branch'
  }), expectCode('ORG_CODE_CONFLICT'));
  assert.throws(() => harness.moveOrgUnit({
    actorTenantId: tenantId, orgUnitId: root.id, newParentId: branch.id, expectedVersion: 1
  }), expectCode('ORG_CYCLE'));

  assert.deepEqual(harness.snapshot(), before);
  assert.equal(root.parentId, null);
  assert.equal(root.version, 1);
});

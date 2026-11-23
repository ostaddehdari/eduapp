export class DomainError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
  }
}

const normalizeCode = (value) => value.trim().toLowerCase();

export class CommercialJourneyHarness {
  #sequence = 0;

  constructor() {
    this.providerEvents = new Map();
    this.subscriptions = new Map();
    this.ledgerEntries = [];
    this.entitlements = [];
    this.tenants = new Map();
    this.tenantBySubscription = new Map();
    this.orgUnits = new Map();
    this.schools = new Map();
  }

  nextId(prefix) {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }

  verifyAndProvisionPayment({ provider, providerEventId, verified, subscriptionId, ownerIdentityId }) {
    const eventKey = `${provider}:${providerEventId}`;
    if (!verified) throw new DomainError('PAYMENT_NOT_VERIFIED');

    const existing = this.providerEvents.get(eventKey);
    if (existing) return { ...existing, deduplicated: true };

    let tenantId = this.tenantBySubscription.get(subscriptionId);
    if (!tenantId) {
      tenantId = this.nextId('tenant');
      this.tenants.set(tenantId, { id: tenantId, subscriptionId, ownerIdentityId, status: 'active' });
      this.tenantBySubscription.set(subscriptionId, tenantId);
      this.subscriptions.set(subscriptionId, { id: subscriptionId, tenantId, status: 'active' });
      this.ledgerEntries.push({ id: this.nextId('ledger'), subscriptionId, direction: 'credit' });
      this.entitlements.push({ id: this.nextId('entitlement'), tenantId, feature: 'school-core' });
    }

    const result = { eventKey, tenantId, subscriptionId, deduplicated: false };
    this.providerEvents.set(eventKey, result);
    return result;
  }

  createOrgUnit({ actorTenantId, parentId = null, code, kind }) {
    if (!this.tenants.has(actorTenantId)) throw new DomainError('TENANT_CONTEXT_MISMATCH');
    if (parentId) {
      const parent = this.orgUnits.get(parentId);
      if (!parent || parent.tenantId !== actorTenantId) throw new DomainError('ORG_PARENT_NOT_FOUND');
    }

    const normalizedCode = normalizeCode(code);
    const conflict = [...this.orgUnits.values()].some(
      (unit) => unit.tenantId === actorTenantId && unit.parentId === parentId && unit.code === normalizedCode
    );
    if (conflict) throw new DomainError('ORG_CODE_CONFLICT');

    const id = this.nextId('org');
    this.orgUnits.set(id, { id, tenantId: actorTenantId, parentId, code: normalizedCode, kind, version: 1 });
    return this.orgUnits.get(id);
  }

  moveOrgUnit({ actorTenantId, orgUnitId, newParentId, expectedVersion }) {
    const unit = this.orgUnits.get(orgUnitId);
    if (!unit || unit.tenantId !== actorTenantId) throw new DomainError('ORG_UNIT_NOT_FOUND');
    const parent = this.orgUnits.get(newParentId);
    if (!parent || parent.tenantId !== actorTenantId) throw new DomainError('ORG_PARENT_NOT_FOUND');
    if (unit.version !== expectedVersion) throw new DomainError('ORG_VERSION_CONFLICT');

    let cursor = parent;
    while (cursor) {
      if (cursor.id === unit.id) throw new DomainError('ORG_CYCLE');
      cursor = cursor.parentId ? this.orgUnits.get(cursor.parentId) : null;
    }

    unit.parentId = newParentId;
    unit.version += 1;
    return unit;
  }

  createSchool({ actorTenantId, orgUnitId, name }) {
    const orgUnit = this.orgUnits.get(orgUnitId);
    if (!orgUnit || orgUnit.tenantId !== actorTenantId) throw new DomainError('ORG_UNIT_NOT_FOUND');
    const existing = [...this.schools.values()].find(
      (school) => school.tenantId === actorTenantId && school.orgUnitId === orgUnitId
    );
    if (existing) return { ...existing, deduplicated: true };

    const id = this.nextId('school');
    const school = { id, tenantId: actorTenantId, orgUnitId, name, deduplicated: false };
    this.schools.set(id, school);
    return school;
  }

  snapshot() {
    return {
      providerEvents: this.providerEvents.size,
      subscriptions: this.subscriptions.size,
      ledgerEntries: this.ledgerEntries.length,
      entitlements: this.entitlements.length,
      tenants: this.tenants.size,
      orgUnits: this.orgUnits.size,
      schools: this.schools.size
    };
  }
}

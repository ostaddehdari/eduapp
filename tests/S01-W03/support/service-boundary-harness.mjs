export class DomainError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

const canonicalPayload = (payload) => JSON.stringify(payload, Object.keys(payload).sort());

export class ServiceBoundaryHarness {
  constructor({ contract, model }) {
    this.contract = contract;
    this.model = model;
    this.contexts = new Map(model.context_routes.map((route) => [route.context, route]));
    this.owners = new Map(model.ownership_runtime_map.map((owner) => [owner.owner, owner]));
    this.memberships = new Map();
    this.connection = { tenantId: null, epoch: 0 };
    this.records = new Map(model.context_routes.map(({ context }) => [context, new Map()]));
    this.financialCommands = new Map();
    this.ledgerEntries = [];
    this.outbox = [];
    this.inbox = new Set();
    this.eventEffects = [];
  }

  grantMembership(identityId, tenantId) {
    const memberships = this.memberships.get(identityId) ?? new Set();
    memberships.add(tenantId);
    this.memberships.set(identityId, memberships);
  }

  resetConnection() {
    this.connection.tenantId = null;
    this.connection.epoch += 1;
  }

  bindTenant({ identityId, tenantId }) {
    this.resetConnection();
    if (!this.memberships.get(identityId)?.has(tenantId)) {
      throw new DomainError('TENANT_CONTEXT_MISMATCH');
    }
    this.connection.tenantId = tenantId;
    return { tenantId, epoch: this.connection.epoch };
  }

  requireTenant() {
    if (!this.connection.tenantId) throw new DomainError('TENANT_CONTEXT_NOT_BOUND');
    return this.connection.tenantId;
  }

  writeOwnedRecord({ callerContext, targetContext, recordId, value }) {
    const tenantId = this.requireTenant();
    if (!this.contexts.has(callerContext) || !this.contexts.has(targetContext)) {
      throw new DomainError('UNKNOWN_BOUNDED_CONTEXT');
    }
    if (callerContext !== targetContext) throw new DomainError('FOREIGN_DATA_OWNER');

    const key = `${tenantId}:${recordId}`;
    const record = { tenantId, recordId, value };
    this.records.get(targetContext).set(key, record);
    return structuredClone(record);
  }

  readOwnedRecord({ context, recordId }) {
    const tenantId = this.requireTenant();
    const record = this.records.get(context)?.get(`${tenantId}:${recordId}`);
    if (!record) throw new DomainError('OWNED_RECORD_NOT_FOUND');
    return structuredClone(record);
  }

  executeFinancialCommand({ idempotencyKey, payload }) {
    const tenantId = this.requireTenant();
    if (!idempotencyKey) throw new DomainError('IDEMPOTENCY_KEY_REQUIRED');

    const key = `${tenantId}:${idempotencyKey}`;
    const payloadHash = canonicalPayload(payload);
    const prior = this.financialCommands.get(key);
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH');
      return { ...prior.result, deduplicated: true };
    }

    const result = { tenantId, ledgerId: `ledger-${this.ledgerEntries.length + 1}` };
    this.ledgerEntries.push({ ...result, amountMinor: payload.amountMinor });
    this.outbox.push({ tenantId, type: 'billing.subscription_activated.v1', aggregateId: payload.subscriptionId });
    this.financialCommands.set(key, { payloadHash, result });
    return { ...result, deduplicated: false };
  }

  deliverEvent({ consumer, eventId, type, payload }) {
    const event = this.model.event_delivery.find((candidate) => candidate.type === type);
    if (!event || !event.consumers.includes(consumer)) throw new DomainError('EVENT_CONTRACT_UNSUPPORTED');

    const inboxKey = `${consumer}:${eventId}`;
    if (this.inbox.has(inboxKey)) return { deduplicated: true, sideEffectApplied: false };

    this.inbox.add(inboxKey);
    this.eventEffects.push({ consumer, eventId, type, payload: structuredClone(payload) });
    return { deduplicated: false, sideEffectApplied: true };
  }

  evaluateSplit(evidenceIds) {
    const evidence = new Set(evidenceIds);
    const allMandatory = this.model.split_decision.required_always.every((gate) => evidence.has(gate));
    const oneDriver = this.model.split_decision.required_any.some((gate) => evidence.has(gate));
    if (!allMandatory || !oneDriver) throw new DomainError(this.model.split_decision.incomplete_error);

    return {
      result: this.model.split_decision.approval_result,
      automaticSplit: this.model.split_decision.automatic_split,
      nextState: 'reviewed',
    };
  }

  snapshot() {
    return {
      boundTenant: this.connection.tenantId,
      connectionEpoch: this.connection.epoch,
      records: [...this.records.values()].reduce((sum, records) => sum + records.size, 0),
      ledgerEntries: this.ledgerEntries.length,
      outboxEvents: this.outbox.length,
      inboxEntries: this.inbox.size,
      eventEffects: this.eventEffects.length,
    };
  }
}

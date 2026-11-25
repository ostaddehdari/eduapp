import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readJson = (relativePath) => JSON.parse(
  readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8'),
);
const design = readJson('docs/contracts/S02-W03.json');
const boundary = readJson('docs/contracts/S01-W03.json');
const operatingModel = readJson('docs/architecture/service-boundary-operating-model.v1.json');
const gateway = readJson('docs/contracts/S02-W02.json');
const openapi = readJson('preview/api/openapi.json');

assert.equal(design.schema_version, 1);
assert.equal(design.contract_id, 'S02-W03');
assert.equal(design.task_id, 'S02-W03-T01');
assert.match(design.version, /^\d+\.\d+\.\d+$/);
assert.deepEqual(design.requirement_ids, ['DATA-001']);

const { ownership, roles, tenant_transaction: transactions, tenant_policy: policy } = design;
assert.deepEqual(
  ownership.map(({ tables, ...owner }) => owner),
  operatingModel.ownership_runtime_map,
  'Schema owners and runtimes must match the operating model',
);
assert.deepEqual(
  ownership.map(({ owner, context, tables }) => ({ owner, context, tables: tables.map(({ name }) => name) })),
  boundary.table_ownership,
  'Every table must stay with its Stage 1 owner',
);

const globalTables = new Map([
  ['identities', 'owner_private_global'], ['sessions', 'owner_private_global'],
  ['provider_events', 'owner_private_global'], ['plans', 'shared_catalog'], ['plan_versions', 'shared_catalog'],
]);
const appendOnly = new Set(['ledger_entries', 'page_revisions', 'attendance_revisions', 'audit_events']);
const tables = new Map();
for (const { owner, tables: ownedTables } of ownership) {
  for (const table of ownedTables) {
    assert(!tables.has(table.name), `Duplicate table ${table.name}`);
    const scope = table.name === 'tenants' ? 'tenant_root' : globalTables.get(table.name) ?? 'tenant';
    const tenantKey = scope === 'tenant_root' ? 'id' : scope === 'tenant' ? 'tenant_id' : null;
    assert.equal(table.scope, scope, `Wrong row scope for ${table.name}`);
    assert.equal(table.tenant_key, tenantKey, `Wrong tenant key for ${table.name}`);
    assert.equal(table.append_only ?? false, appendOnly.has(table.name), `Wrong write policy for ${table.name}`);
    tables.set(table.name, { ...table, owner });
  }
}

for (const name of ['api_owner_runtime', 'worker_owner_runtime']) {
  assert.deepEqual(roles[name], {
    login: true, superuser: false, bypass_rls: false, owns_tables: false,
    can_assume_privileged_role: false, grants: 'owner_service_only',
  }, `Invalid runtime grants for ${name}`);
}
assert.equal(roles.schema_owner.login, false);
assert.equal(roles.schema_owner.owns_tables, true);
assert.equal(roles.migration_runner.grants, 'reviewed_schema_owner_only');
assert.equal(roles.migration_runner.bypass_rls, false);
for (const name of ['api_gateway', 'public_web', 'control_panel', 'support_analyst']) {
  assert.equal(roles[name].connect, false, `${name} must use the service boundary`);
}
assert.deepEqual(policy, {
  enable_rls: true, force_rls: true,
  using: 'tenant_key_equals_bound_tenant', with_check: 'tenant_key_equals_bound_tenant',
  absent_or_empty: 'deny', tenant_id_not_null: true, owner_reference: 'tenant_qualified_foreign_key',
  cross_owner_reference: 'owner_contract_only', schema_create_grant: false, truncate_grant: false,
});
assert.deepEqual(transactions, {
  connection: 'one_checked_out_connection', parameter: 'app.tenant_id', bind: 'transaction_local',
  begin: 'BEGIN', success: ['bind_verified_tenant', 'run_owner_queries', 'COMMIT', 'release'],
  failure: ['ROLLBACK', 'release'], uncertain_cleanup: 'discard_connection',
  unbound: 'deny', invalid_tenant: 'reject_before_binding',
});

for (const { table, columns, references, reference_columns: referencedColumns } of design.owner_foreign_keys) {
  const child = tables.get(table);
  const parent = tables.get(references);
  assert(child && parent && child.owner === parent.owner, `Foreign owner reference ${table} to ${references}`);
  assert.deepEqual([child.scope, parent.scope], ['tenant', 'tenant']);
  assert.equal(columns.length, referencedColumns.length);
  assert(columns.length > 1 && columns[0] === child.tenant_key && referencedColumns[0] === parent.tenant_key);
}

for (const { table, columns, unique, predicate } of design.indexes) {
  const model = tables.get(table);
  assert(model && columns.length > 0 && typeof unique === 'boolean', `Invalid index for ${table}`);
  const key = `${table}:${columns.join(',')}`;
  if (key === 'domains:host_normalized') {
    assert(unique && predicate === 'verified');
  } else if (key === 'provider_events:provider,provider_event_id' || key === 'inbox_dedup:consumer,event_id') {
    assert(unique && predicate === undefined);
  } else {
    assert.equal(columns[0], model.tenant_key, `Index for ${table} must lead with the tenant key`);
  }
}

const operations = new Map(Object.values(openapi.paths).flatMap((methods) =>
  Object.values(methods).filter(({ operationId }) => operationId).map((op) => [op.operationId, op]),
));
const tagOwners = new Map(boundary.api_tag_ownership.map(({ tag, context }) => [tag, context]));
const mapped = new Map();
for (const { operation_id: id, context, tenant_source: source } of design.api_operations) {
  assert(!mapped.has(id), `Duplicate API operation ${id}`);
  const tags = operations.get(id)?.tags ?? [];
  assert(tags.length > 0 && tags.every((tag) => tagOwners.get(tag) === context), `API owner mismatch for ${id}`);
  assert(source, `No tenant source for ${id}`);
  mapped.set(id, source);
}
for (const [id, source] of [
  ['createTenant', 'authorized_provisioning'], ['listPlans', 'shared_catalog'],
  ['createEnrollment', 'verified_membership'], ['submitAttendanceBatch', 'verified_membership'],
  ['ingestDeviceEvent', 'verified_device_registration'],
  [gateway.routing.provider_callback_operation, 'verified_provider_and_owned_invoice'],
]) {
  assert.equal(mapped.get(id), source, `Wrong tenant source for ${id}`);
}

assert.deepEqual(design.events, boundary.event_contracts);
assert.deepEqual(design.events, operatingModel.event_delivery);
assert.deepEqual(design.event_storage, {
  new_types: [], tenant_binding: 'trusted_producer_and_validated_owner_reference',
  publish: 'transactional_outbox', consume: 'dedupe_in_same_transaction_as_durable_effect',
  dedupe_columns: ['tenant_id', 'consumer', 'event_id'],
});
assert(design.indexes.some(({ table, columns, unique }) =>
  table === 'inbox_dedup' && unique && columns.join(',') === design.event_storage.dedupe_columns.join(','),
), 'Missing tenant inbox unique index');

console.log(`PostgreSQL tenant contract ${design.version}: ${tables.size} tables, ${ownership.length} owners, ${mapped.size} API operations, ${design.events.length} event types`);

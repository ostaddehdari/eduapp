import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const policy = read('docs/contracts/S02-W02.json');
const oas = read(policy.sources.components);
const catalog = read(policy.sources.catalog);
const ownership = read(policy.sources.ownership);
const commercial = read(policy.sources.commercial);
const { routing, request_id: requestId, pagination, idempotency, concurrency, errors } = policy;

assert.equal(policy.contract_id, 'S02-W02');
assert.equal(policy.version, oas.info.version);
assert.deepEqual(policy.requirement_ids, ['OPS-001']);
assert.equal(policy.scope, 'gateway_contract_only');
assert.equal(policy.next_task, 'S02-W02-T02');
assert.equal(oas.openapi, '3.1.0');
assert.deepEqual(oas.paths, {});
assert.equal(oas.servers[0].url, catalog.servers[0].url);
assert.equal(routing.public_base, catalog.servers[0].url);
assert.equal(new URL(routing.public_base).pathname, '/eduapp/api/v1');
assert.equal(routing.internal_prefix, '/v1');

function checkReferences(value) {
  if (Array.isArray(value)) {
    value.forEach(checkReferences);
  } else if (value && typeof value === 'object') {
    if (typeof value.$ref === 'string') {
      assert.match(value.$ref, /^#\/components\//);
      const target = value.$ref.slice(2).split('/').reduce((item, key) => item?.[key], oas);
      assert.ok(target, 'Unresolved reference: ' + value.$ref);
    }
    Object.values(value).forEach(checkReferences);
  }
}
checkReferences(oas);

const operations = new Map();
const routeOwners = new Map(ownership.api_tag_ownership.map(({ tag, context }) => [tag, context]));
const verbs = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace']);
for (const [path, items] of Object.entries(catalog.paths)) {
  for (const [method, op] of Object.entries(items)) {
    if (!verbs.has(method)) continue;
    assert.equal(typeof op.operationId, 'string');
    assert.ok(!operations.has(op.operationId), 'Duplicate operation ID: ' + op.operationId);
    assert.equal(op.tags.length, 1, 'One owning tag required: ' + op.operationId);
    assert.ok(routeOwners.has(op.tags[0]), 'Missing owner: ' + op.operationId);
    operations.set(op.operationId, { ...op, path, method, owner: routeOwners.get(op.tags[0]) });
  }
}
assert.equal(operations.size, routing.existing_operation_count);
const callback = operations.get(routing.provider_callback_operation);
assert.equal(callback.owner, routing.provider_callback_owner);
assert.equal(callback.method, 'post');
assert.equal(commercial.api_contracts.find(op => op.operation_id === callback.operationId).auth, routing.provider_callback_verification);
assert.equal(routing.domain_authorization, 'domain_owner');
assert.equal(routing.accept_client_context_headers, false);

const { schemas, parameters, headers, responses } = oas.components;
assert.equal(requestId.header, 'X-Request-Id');
assert.equal(requestId.accept_client_value, false);
assert.equal(headers.RequestId.schema.$ref, '#/components/schemas/RequestId');
assert.equal(schemas.RequestId.format, 'uuid');
for (const envelope of [policy.response.success, policy.response.paged, policy.response.failure]) {
  assert.ok(schemas[envelope].required.includes('meta'));
}
assert.equal(schemas.RequestMeta.properties.requestId.$ref, headers.RequestId.schema.$ref);
assert.equal(schemas.SuccessMeta.properties.requestId.$ref, headers.RequestId.schema.$ref);
assert.equal(schemas.SuccessMeta.properties.version.const, policy.response.transport_version);
assert.deepEqual(schemas.ErrorEnvelope.properties.error.required, ['code', 'message', 'details']);

assert.deepEqual(Object.keys(responses).sort(), errors.map(({ code }) => code).sort());
for (const { status, code } of errors) {
  const response = responses[code];
  assert.equal(response.description, status + ' ' + code);
  assert.equal(response.headers[requestId.header].$ref, '#/components/headers/RequestId');
  assert.equal(response.content['application/json'].schema.$ref, '#/components/schemas/ErrorEnvelope');
}
assert.equal(responses.RATE_LIMITED.headers['Retry-After'].$ref, '#/components/headers/RetryAfter');
assert.equal(headers.RetryAfter.schema.type, 'integer');
assert.equal(headers.RetryAfter.schema.minimum, 1);
assert.equal(responses.AUTHENTICATION_REQUIRED.headers['WWW-Authenticate'].$ref, '#/components/headers/Authenticate');

assert.equal(parameters.Cursor.in, 'query');
assert.equal(parameters.Limit.schema.default, pagination.limit_default);
assert.equal(parameters.Limit.schema.maximum, pagination.limit_max);
assert.ok(pagination.limit_default > 0 && pagination.limit_default <= pagination.limit_max);
assert.ok(Number.isSafeInteger(pagination.cursor_ttl_seconds) && pagination.cursor_ttl_seconds > 0);
assert.deepEqual(pagination.bound_to, ['operation', 'verified_scope', 'normalized_query']);
assert.equal(pagination.cross_scope_cursor, pagination.invalid_cursor);
assert.deepEqual(pagination.operation_ids, [...operations.keys()].filter(id => id.startsWith('list')));
for (const id of pagination.operation_ids) assert.equal(operations.get(id).method, 'get');
assert.ok(schemas.PageMeta.allOf.some(schema => schema.required?.includes('nextCursor')));

assert.equal(parameters.IdempotencyKey.name, idempotency.header);
assert.equal(parameters.IdempotencyKey.required, true);
assert.equal(parameters.IdempotencyKey.schema.minLength, idempotency.key_min_length);
assert.equal(parameters.IdempotencyKey.schema.maxLength, idempotency.key_max_length);
assert.deepEqual(parameters.IdempotencyKey, catalog.components.parameters.IdempotencyKey);
assert.deepEqual(idempotency.namespace, ['verified_scope', 'authenticated_actor', 'operation', 'key']);
for (const [id, op] of operations) {
  if (op.parameters?.some(param => param.$ref === '#/components/parameters/IdempotencyKey')) {
    assert.ok(idempotency.client_operations.includes(id), 'Missing existing key contract: ' + id);
  }
}
for (const id of idempotency.client_operations) assert.equal(operations.get(id)?.method, 'post');
assert.ok(!idempotency.client_operations.includes(callback.operationId));
assert.equal(idempotency.durable_outcome_owner, 'domain_owner');
assert.equal(parameters.IfMatch.name, concurrency.request_header);
assert.equal(parameters.IfMatch.required, true);
assert.deepEqual(concurrency.required_operations, ['updateRole']);
assert.equal(operations.get('updateRole').method, 'patch');
assert.equal(concurrency.missing, 428);
assert.equal(concurrency.stale, 412);

assert.deepEqual(policy.data_ownership.gateway_table_ownership, []);
assert.deepEqual(policy.data_ownership.new_tables, []);
assert.deepEqual(policy.events.new_events, []);
assert.equal(policy.events.gateway_domain_event_writes, false);
const tables = new Map(ownership.table_ownership.flatMap(({ owner, tables }) => tables.map(table => [table, owner])));
for (const group of policy.data_ownership.durable) {
  for (const table of group.tables) assert.equal(tables.get(table), group.owner, 'Table owner: ' + table);
}
for (const event of policy.events.references) assert.ok(ownership.event_contracts.some(e => e.type === event), event);
const gateway = policy.permissions.find(row => row.actor === 'api_gateway');
const stageOneGateway = ownership.access_matrix.find(row => row.actor === 'api_gateway');
assert.deepEqual(gateway.allow, stageOneGateway.allow);
assert.ok(stageOneGateway.deny.every(action => gateway.deny.includes(action)));
assert.ok(gateway.deny.includes('publish_domain_events'));
assert.equal(new Set(policy.permissions.map(row => row.actor)).size, 6);
assert.ok(policy.permissions.every(row => row.allow.length && row.deny.length));

assert.equal(policy.rate_limit.over_limit, 429);
assert.equal(policy.rate_limit.unavailable_required_limiter, 503);
assert.equal(policy.compatibility.pin_generator, true);
assert.equal(policy.compatibility.compare_generated_artifact, true);
assert.equal(policy.compatibility.internal_operations_in_public_sdk, false);
assert.ok(policy.compatibility.block_breaking.includes('remove_operation'));
assert.ok(policy.compatibility.block_breaking.includes('require_new_request_input'));

console.log('Gateway contract validated: ' + operations.size + ' owned routes, ' +
  pagination.operation_ids.length + ' paginated operations, ' + errors.length +
  ' response definitions; ownership and permission boundaries verified.');

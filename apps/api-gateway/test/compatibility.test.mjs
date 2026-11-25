import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkCompatibility, generateSdk } from '../../../scripts/gateway-contract-tools.mjs';

const read = path => readFileSync(new URL('../../../' + path, import.meta.url), 'utf8');
const active = JSON.parse(read('packages/contracts/openapi/gateway-active-v1.json'));
const catalog = JSON.parse(read('preview/api/openapi.json'));

function breaks(base, change, expected) {
  const modified = structuredClone(base);
  change(modified);
  assert.ok(checkCompatibility(base, modified).some(message => message.includes(expected)), expected);
}

test('identical specs and a documentation-only edit are compatible', () => {
  assert.deepEqual(checkCompatibility(active, active), []);
  assert.deepEqual(checkCompatibility(catalog, catalog), []);
  const modified = structuredClone(active);
  modified.info.description = 'Additional documentation';
  assert.deepEqual(checkCompatibility(active, modified), []);
});

test('breaking operation or response changes are detected', () => {
  breaks(active, spec => { delete spec.paths['/health/live']; }, 'removed');
  breaks(active, spec => { spec.paths['/version'].get.operationId = 'changedVersion'; }, 'operationId');
  breaks(active, spec => { delete spec.paths['/version'].get.responses['200']; }, 'response changed');
  breaks(active, spec => {
    const data = spec.components.schemas.HealthEnvelope.properties.data;
    data.properties.status = { type: 'string', enum: ['ok', 'unknown'] };
  }, 'response changed');
  breaks(active, spec => {
    const data = spec.components.schemas.VersionEnvelope.properties.data;
    delete data.properties.version;
    data.required = [];
  }, 'response changed');
});

test('new required input and narrower inputs are detected', () => {
  breaks(active, spec => {
    spec.paths['/version'].get.parameters = [
      { in: 'query', name: 'mode', required: true, schema: { type: 'string' } },
    ];
  }, 'new required parameter');
  breaks(catalog, spec => { spec.components.parameters.IdempotencyKey.schema.minLength += 1; }, 'request parameter changed');
});

test('the checked-in SDK is deterministic and covers the executable routes', () => {
  const sdk = read('packages/contracts/src/gateway-sdk.generated.ts');
  assert.equal(sdk, generateSdk(active));
  for (const operation of ['getLiveness', 'getReadiness', 'getVersion']) assert.ok(sdk.includes(operation + ':'));
  assert.ok(!sdk.includes('createCheckout'));
});

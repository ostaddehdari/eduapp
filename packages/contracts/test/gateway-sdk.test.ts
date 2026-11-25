import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatewayClient, GatewayApiError } from '../src/gateway-sdk.generated.js';

test('the generated SDK retains the public base path and typed payload', async () => {
  const controller = new AbortController();
  const client = createGatewayClient('https://example.test/eduapp/api/v1/', async (input, init) => {
    assert.equal(String(input), 'https://example.test/eduapp/api/v1/health/live');
    assert.equal(init?.signal, controller.signal);
    return Response.json({ data: { status: 'ok' }, meta: { requestId: 'example', version: 'v1' } });
  });
  assert.equal((await client.getLiveness(controller.signal)).data.status, 'ok');
});

test('the generated SDK surfaces structured HTTP failures', async () => {
  const client = createGatewayClient('http://127.0.0.1:3010/v1', async () =>
    Response.json({ error: { code: 'SERVICE_UNAVAILABLE' } }, {
      status: 503,
      headers: { 'X-Request-Id': 'example' },
    }));
  await assert.rejects(client.getReadiness(), error => {
    assert.ok(error instanceof GatewayApiError);
    assert.equal(error.status, 503);
    assert.equal(error.requestId, 'example');
    return true;
  });
});

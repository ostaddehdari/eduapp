import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createGatewayRuntime } from '../../apps/api-gateway/src/runtime.mjs';
import { readMonitoringOptions } from '../../infra/monitoring/runtime.mjs';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
    server.closeAllConnections();
  }));
  return { port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` };
}

test('development logs and metrics exclude input from both tenant scopes', async (t) => {
  const input = {
    actor: 'synthetic-person-41',
    scopeA: 'sensitive-scope-a-41',
    scopeB: 'sensitive-scope-b-41',
    tokenA: 'synthetic-bearer-token-a-41',
    tokenB: 'synthetic-bearer-token-b-41',
    email: 'sensitive-input-41@example.test',
    path: 'sensitive-path-id-41',
    cookie: 'sensitive-cookie-41',
    exception: 'sensitive-exception-41',
    requestId: 'sensitive-incoming-request-id-41',
    traceId: '12345678901234567890123456789012',
    traceSpan: '1234567890123456',
    body: 'sensitive-body-41',
    idempotencyKey: 'sensitive-idempotency-key-41',
  };
  const logs = [];
  const monitoring = readMonitoringOptions({ EDUAPP_MONITORING_MODE: 'development' }, 3010);
  const { gateway, metrics } = createGatewayRuntime({
    monitoring,
    emit: (record) => logs.push(record),
    gatewayOptions: {
      authenticate: (token) => {
        if (token === `Bearer ${input.tokenA}`) return { actor: input.actor, scope: input.scopeA };
        if (token === `Bearer ${input.tokenB}`) return { actor: input.actor, scope: input.scopeB };
        return null;
      },
      routes: [{
        id: 'getTenant',
        queryKeys: ['search'],
        budget: { max: 10, windowSeconds: 60 },
        authorize: () => true,
        handle: ({ identity, params, query }) => {
          assert.equal(params.tenantId, input.path);
          assert.equal(query.search, input.email);
          if (identity.scope === input.scopeB) throw new Error(input.exception);
          return { data: { name: input.email } };
        },
      }, {
        id: 'createEnrollment',
        budget: { max: 10, windowSeconds: 60 },
        authorize: () => true,
        executeIdempotent: (_request, execute) => execute(),
        handle: ({ body }) => {
          assert.equal(body.name, input.body);
          return { data: { created: true }, status: 201 };
        },
      }],
    },
  });
  const { origin } = await listen(t, gateway);
  const { origin: internal } = await listen(t, metrics);
  const url = `${origin}/v1/tenants/${input.path}?search=${encodeURIComponent(input.email)}`;
  const headers = {
    authorization: `Bearer ${input.tokenA}`,
    cookie: `session=${input.cookie}`,
    'x-request-id': input.requestId,
    'x-tenant-id': input.scopeB,
    traceparent: `00-${input.traceId}-${input.traceSpan}-01`,
  };

  const healthy = await fetch(url, { headers });
  assert.equal(healthy.status, 200);
  assert.equal((await healthy.json()).data.name, input.email);
  const failing = await fetch(url, { headers: { ...headers, authorization: `Bearer ${input.tokenB}` } });
  assert.equal(failing.status, 503);
  assert(!JSON.stringify(await failing.json()).includes(input.exception));
  const created = await fetch(origin + '/v1/enrollments', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey },
    body: JSON.stringify({ name: input.body }),
  });
  assert.equal(created.status, 201);
  assert.equal((await fetch(origin + '/metrics')).status, 404);
  const scrape = await fetch(internal + '/metrics');
  assert.equal(scrape.status, 200);
  assert.match(scrape.headers.get('content-type'), /version=0\.0\.4/);
  assert.equal((await fetch(internal + '/metrics', { method: 'POST' })).status, 405);
  assert.equal((await fetch(internal + '/v1/health/live')).status, 404);

  const trace = logs.filter((record) => record.operation === 'getTenant');
  assert.deepEqual(trace.map(({ request_id, status }) => [request_id, status]), [
    [healthy.headers.get('x-request-id'), 200],
    [failing.headers.get('x-request-id'), 503],
  ]);
  assert.match(trace[0].trace_id, /^[0-9a-f]{32}$/);
  assert.notEqual(trace[0].trace_id, trace[1].trace_id);

  const metricsText = await scrape.text();
  assert.match(metricsText, /eduapp_gateway_http_requests_total\{operation="getTenant",method="GET",status="200"\} 1/);
  assert.match(metricsText, /eduapp_gateway_http_requests_total\{operation="getTenant",method="GET",status="503"\} 1/);
  assert.match(metricsText, /eduapp_gateway_http_requests_total\{operation="createEnrollment",method="POST",status="201"\} 1/);
  assert.match(metricsText, /eduapp_gateway_http_duration_seconds_count\{operation="getTenant",method="GET"\} 2/);
  const telemetry = JSON.stringify(logs) + metricsText;
  for (const value of Object.values(input)) assert(!telemetry.includes(value), 'request material escaped into telemetry');
});

test('staging readiness closes on API error and timeout and resolves its alert on recovery', async (t) => {
  let status = 'ok';
  const probes = [];
  const records = [];
  const ineligibleOutput = 'dependency-credentials-must-not-leak';
  const api = await listen(t, createServer((req, res) => {
    probes.push([req.url, req.headers.traceparent, req.headers['x-request-id']]);
    if (status === 'timeout') return;
    res.writeHead(status === 'ok' ? 200 : 503).end(ineligibleOutput);
  }));
  const monitoring = readMonitoringOptions({
    EDUAPP_MONITORING_MODE: 'staging', EDUAPP_READINESS_API_PORT: String(api.port),
    EDUAPP_METRICS_PORT: api.port === 9464 ? '9465' : '9464',
  }, 3010);
  const { gateway, metrics } = createGatewayRuntime({ monitoring, emit: (record) => records.push(record) });
  const { origin } = await listen(t, gateway);
  const { origin: internal } = await listen(t, metrics);

  assert.doesNotMatch(await (await fetch(internal + '/metrics')).text(), /\neduapp_gateway_readiness /);
  const healthy = await fetch(origin + '/v1/health/ready');
  assert.equal(healthy.status, 200);
  status = 'outage';
  assert.equal((await fetch(origin + '/v1/health/ready')).status, 503);
  assert.equal((await fetch(origin + '/v1/health/live')).status, 200);
  const unhealthyMetrics = await (await fetch(internal + '/metrics')).text();
  assert.match(unhealthyMetrics, /\neduapp_gateway_readiness 0\n/);
  status = 'timeout';
  assert.equal((await fetch(origin + '/v1/health/ready')).status, 503);

  status = 'ok';
  assert.equal((await fetch(origin + '/v1/health/ready')).status, 200);
  const recovered = await (await fetch(internal + '/metrics')).text();
  assert.match(recovered, /\neduapp_gateway_readiness 1\n/);
  const alerts = records.filter((record) => record.event === 'gateway.alert');
  assert.deepEqual(alerts.map(({ name, state }) => [name, state]), [
    ['GatewayReadiness', 'firing'], ['GatewayReadiness', 'resolved'],
  ]);
  const requestId = healthy.headers.get('x-request-id');
  const requestSpan = records.find((record) => record.event === 'gateway.request.completed' && record.request_id === requestId);
  const probe = records.find((record) => record.event === 'gateway.readiness.checked' && record.request_id === requestId);
  assert.equal(requestSpan.trace_id, probe.trace_id);
  assert.equal(requestSpan.span_id, probe.parent_span_id);
  assert.deepEqual(probes[0], ['/api/health', `00-${probe.trace_id}-${probe.span_id}-01`, requestId]);
  assert(!JSON.stringify(records).includes(ineligibleOutput));
});

test('monitoring is opt-in, rejects unsafe configuration and counts dropped logs without impacting HTTP', async (t) => {
  assert.equal(readMonitoringOptions({}, 3010), null);
  assert.equal(createGatewayRuntime().metrics, null);
  assert.throws(() => readMonitoringOptions({ EDUAPP_MONITORING_MODE: 'production' }, 3010),
    { message: 'Invalid EDUAPP_MONITORING_MODE' });
  assert.throws(() => readMonitoringOptions({ EDUAPP_MONITORING_MODE: 'staging' }, 3010),
    { message: 'EDUAPP_READINESS_API_PORT is required in staging' });
  assert.throws(() => readMonitoringOptions({
    EDUAPP_MONITORING_MODE: 'development', EDUAPP_METRICS_PORT: 'private-value',
  }, 3010), { message: 'Invalid EDUAPP_METRICS_PORT' });
  assert.throws(() => readMonitoringOptions({
    EDUAPP_MONITORING_MODE: 'development', EDUAPP_METRICS_PORT: '3010',
  }, 3010), { message: 'Gateway, metrics and API readiness ports must be distinct' });
  let calls = 0;
  const { gateway, metrics } = createGatewayRuntime({
    monitoring: readMonitoringOptions({ EDUAPP_MONITORING_MODE: 'development' }, 3010),
    emit: () => {
      calls += 1;
      if (calls === 1) throw new Error('sensitive stdout error');
      return false;
    },
  });
  const { origin } = await listen(t, gateway);
  const { origin: internal } = await listen(t, metrics);
  assert.equal((await fetch(origin + '/v1/health/live')).status, 200);
  assert.equal((await fetch(origin + '/v1/version')).status, 200);
  const text = await (await fetch(internal + '/metrics')).text();
  assert.match(text, /\neduapp_gateway_telemetry_dropped_total 2\n/);
  assert(!text.includes('sensitive stdout error'));
});

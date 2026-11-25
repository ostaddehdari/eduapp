import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createGateway, GatewayError } from '../../apps/api-gateway/src/gateway.mjs';
import { createMemoryRateLimiter } from '../../apps/api-gateway/src/limits.mjs';
import { createGatewayClient, GatewayApiError } from '../../packages/contracts/src/gateway-sdk.generated.ts';

const tenants = {
  amber: { scope: 'school-amber', actor: 'shared-actor' },
  violet: { scope: 'school-violet', actor: 'shared-actor' },
};
const defaultBudget = { max: 50, windowSeconds: 60 };

async function start(t, options = {}) {
  const server = createServer(createGateway({
    authenticate(header) {
      if (header === 'Bearer fixture-amber') return tenants.amber;
      if (header === 'Bearer fixture-violet') return tenants.violet;
      return null;
    },
    ...options,
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port + '/v1';
}

function tenantFetch(base, tenant, path, options = {}) {
  return fetch(base + path, {
    ...options,
    headers: { ...options.headers, Authorization: 'Bearer fixture-' + tenant },
  });
}

async function verifyResponse(response, status) {
  assert.equal(response.status, status);
  const payload = await response.json();
  const requestId = response.headers.get('x-request-id');
  assert.match(requestId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  assert.equal(payload.meta.requestId, requestId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return payload;
}

const errorCode = async (response, status) => (await verifyResponse(response, status)).error.code;

function siteRoute(budget = defaultBudget) {
  const sites = new Map([
    ['school-amber', ['amber-site-1', 'amber-site-2']],
    ['school-violet', ['violet-site-1', 'violet-site-2']],
  ]);
  return {
    id: 'listSites', budget,
    authorize: ({ identity }) => sites.has(identity.scope),
    handle({ identity, page }) {
      const records = sites.get(identity.scope);
      const startAt = page.position ?? 0;
      const endAt = startAt + page.limit;
      return { data: records.slice(startAt, endAt), nextPosition: endAt < records.length ? endAt : null };
    },
  };
}

test('tenant pagination stays isolated for the same actor in two scopes', async t => {
  const base = await start(t, { routes: [siteRoute()] });
  const firstPage = '/sites?limit=1';
  const amber = await verifyResponse(await tenantFetch(base, 'amber', firstPage), 200);
  const violet = await verifyResponse(await tenantFetch(base, 'violet', firstPage), 200);
  assert.deepEqual(amber.data, ['amber-site-1']);
  assert.deepEqual(violet.data, ['violet-site-1']);
  assert.notEqual(amber.meta.nextCursor, violet.meta.nextCursor);

  const withCursor = token => firstPage + '&cursor=' + token;
  for (const [tenant, page, expected] of [
    ['amber', amber, 'amber-site-2'],
    ['violet', violet, 'violet-site-2'],
  ]) {
    const response = await tenantFetch(base, tenant, withCursor(page.meta.nextCursor));
    const payload = await verifyResponse(response, 200);
    assert.deepEqual(payload.data, [expected]);
    assert.equal(payload.meta.nextCursor, null);
  }
  const refused = await verifyResponse(await tenantFetch(base, 'violet', withCursor(amber.meta.nextCursor)), 400);
  assert.deepEqual(refused.error, { code: 'INVALID_REQUEST', message: 'The request is invalid.', details: [] });
  assert.equal(Object.hasOwn(refused, 'data'), false);
});

test('matching idempotency keys retain separate tenant outcomes and same-scope conflicts', async t => {
  const writes = new Map();
  const outcomes = new Map();
  const base = await start(t, { routes: [{
    id: 'createEnrollment', budget: defaultBudget,
    authorize: ({ identity }) => identity === tenants.amber || identity === tenants.violet,
    async executeIdempotent({ namespace, fingerprint }, commit) {
      const key = JSON.stringify(namespace);
      const existing = outcomes.get(key);
      if (existing?.fingerprint !== undefined && existing.fingerprint !== fingerprint) {
        throw new GatewayError('IDEMPOTENCY_CONFLICT');
      }
      if (existing && !existing.result) throw new GatewayError('IDEMPOTENCY_IN_PROGRESS');
      if (existing) return existing.result;
      const record = { fingerprint };
      outcomes.set(key, record);
      try {
        record.result = await commit();
        return record.result;
      } catch (error) {
        outcomes.delete(key);
        throw error;
      }
    },
    handle({ identity, body }) {
      const count = (writes.get(identity.scope) ?? 0) + 1;
      writes.set(identity.scope, count);
      return { status: 201, data: { id: identity.scope + '-record-' + count, label: body.label } };
    },
  }] });
  const submit = (tenant, label) => tenantFetch(base, tenant, '/enrollments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fixture-shared-key' },
    body: JSON.stringify({ label }),
  });

  const amber = await verifyResponse(await submit('amber', 'amber-record'), 201);
  const violet = await verifyResponse(await submit('violet', 'violet-record'), 201);
  const replay = await verifyResponse(await submit('violet', 'violet-record'), 201);
  assert.equal(amber.data.id, 'school-amber-record-1');
  assert.equal(violet.data.id, 'school-violet-record-1');
  assert.deepEqual(replay.data, violet.data);
  assert.notEqual(replay.meta.requestId, violet.meta.requestId);
  assert.equal(await errorCode(await submit('violet', 'changed'), 409), 'IDEMPOTENCY_CONFLICT');
  assert.deepEqual([...writes.entries()], [['school-amber', 1], ['school-violet', 1]]);
});

test('one tenant reaching its request budget does not consume the other budget', async t => {
  let now = 0;
  const base = await start(t, {
    limiter: createMemoryRateLimiter({ clock: () => now }),
    routes: [siteRoute({ max: 1, windowSeconds: 10 })],
  });
  await verifyResponse(await tenantFetch(base, 'amber', '/sites'), 200);
  const refused = await tenantFetch(base, 'amber', '/sites');
  assert.equal(refused.headers.get('retry-after'), '10');
  assert.equal(await errorCode(refused, 429), 'RATE_LIMITED');
  const other = await verifyResponse(await tenantFetch(base, 'violet', '/sites'), 200);
  assert.deepEqual(other.data, ['violet-site-1', 'violet-site-2']);
  now = 10_000;
  await verifyResponse(await tenantFetch(base, 'amber', '/sites'), 200);
});

test('the generated SDK reads real v1 endpoints and preserves the readiness error and request ID', async t => {
  const base = await start(t, { ready: () => false });
  const client = createGatewayClient(base + '/');
  assert.equal((await client.getLiveness()).data.status, 'ok');
  assert.match((await client.getVersion()).data.version, /^\d+\.\d+\.\d+/);
  await assert.rejects(client.getReadiness(), error => {
    assert.ok(error instanceof GatewayApiError);
    assert.equal(error.status, 503);
    assert.equal(error.body.error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(error.body.meta.requestId, error.requestId);
    return true;
  });
});

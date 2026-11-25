import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createGateway, GatewayError } from '../src/gateway.mjs';
import { createMemoryRateLimiter } from '../src/limits.mjs';

async function start(t, options) {
  const server = createServer(createGateway(options));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port + '/v1';
}

const budget = { max: 60, windowSeconds: 60 };

async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.deepEqual(Object.keys(body.error).sort(), ['code', 'details', 'message']);
  assert.equal(body.error.code, code);
  assert.equal(body.meta.requestId, response.headers.get('x-request-id'));
  return body;
}

test('system HTTP routes issue correlated server IDs and a versioned envelope', async t => {
  const base = await start(t);
  for (const path of ['/health/live', '/health/ready', '/version']) {
    const response = await fetch(base + path, { headers: { 'X-Request-Id': 'external-id' } });
    assert.equal(response.status, 200);
    const { data, meta } = await response.json();
    assert.ok(data.status === 'ok' || typeof data.version === 'string');
    assert.equal(meta.version, 'v1');
    assert.equal(meta.requestId, response.headers.get('x-request-id'));
    assert.match(meta.requestId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
  }
  await expectError(await fetch(base + '/tenants'), 404, 'NOT_FOUND');
});

test('limiter enforces retry seconds and liveness survives a failed limiter', async t => {
  const base = await start(t, { systemBudget: { max: 1, windowSeconds: 10 } });
  assert.equal((await fetch(base + '/version')).status, 200);
  const limited = await fetch(base + '/version');
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  await expectError(limited, 429, 'RATE_LIMITED');

  const unavailable = await start(t, { limiter: { consume() { throw new Error('sensitive detail'); } } });
  assert.equal((await fetch(unavailable + '/health/live')).status, 200);
  const body = await expectError(await fetch(unavailable + '/health/ready'), 503, 'SERVICE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(body), /sensitive detail/);
});

test('memory limiter resets only after the window expires', () => {
  let now = 0;
  const limiter = createMemoryRateLimiter({ clock: () => now, capacity: 1 });
  const window = { max: 1, windowSeconds: 2 };
  assert.deepEqual(limiter.consume('first', window), { retryAfter: null });
  assert.throws(() => limiter.consume('second', window), /Capacity/);
  now = 1000;
  assert.deepEqual(limiter.consume('first', window), { retryAfter: 1 });
  now = 2000;
  assert.deepEqual(limiter.consume('second', window), { retryAfter: null });
});

test('a read adapter returns bounded pages and rejects an invalid or mismatched cursor', async t => {
  const data = ['plan-a', 'plan-b', 'plan-c'];
  const base = await start(t, {
    routes: [{
      id: 'listPlans', budget, queryKeys: ['sort'],
      handle({ page }) {
        const position = page.position ?? 0;
        const nextPosition = position + page.limit;
        return { data: data.slice(position, nextPosition), nextPosition: nextPosition < data.length ? nextPosition : null };
      },
    }],
  });
  const first = await fetch(base + '/plans?limit=2&sort=name');
  assert.equal(first.status, 200);
  const p1 = await first.json();
  assert.deepEqual(p1.data, data.slice(0, 2));
  assert.match(p1.meta.nextCursor, /^[A-Za-z0-9_-]{43}$/);
  const second = await fetch(base + '/plans?limit=2&sort=name&cursor=' + p1.meta.nextCursor);
  assert.equal(second.status, 200);
  const p2 = await second.json();
  assert.deepEqual(p2.data, ['plan-c']);
  assert.equal(p2.meta.nextCursor, null);
  for (const query of ['limit=101', 'cursor=bad', 'limit=1&limit=2', 'limit=2&sort=changed&cursor=' + p1.meta.nextCursor]) {
    await expectError(await fetch(base + '/plans?' + query), 400, 'INVALID_REQUEST');
  }
});

test('an idempotent route authenticates and authorizes each request before replay', async t => {
  const outcomes = new Map();
  let writes = 0, decisions = 0, allowed = true;
  const base = await start(t, {
    authenticate: value => value === 'Bearer fixture' ? { actor: 'fixture-user', scope: 'fixture-tenant' } : null,
    routes: [{
      id: 'createTenant', budget,
      authorize() { decisions += 1; return allowed; },
      async executeIdempotent({ namespace, fingerprint }, execute) {
        const id = JSON.stringify(namespace);
        const previous = outcomes.get(id);
        if (previous && previous.fingerprint !== fingerprint) throw new GatewayError('IDEMPOTENCY_CONFLICT');
        if (previous?.pending) throw new GatewayError('IDEMPOTENCY_IN_PROGRESS');
        if (previous) return previous.result;
        outcomes.set(id, { fingerprint, pending: true });
        try {
          const result = await execute();
          outcomes.set(id, { fingerprint, result });
          return result;
        } catch (error) {
          outcomes.delete(id);
          throw error;
        }
      },
      handle({ identity }) {
        assert.equal(identity.scope, 'fixture-tenant');
        writes += 1;
        return { status: 201, data: { id: 'synthetic' } };
      },
    }],
  });
  const send = (body, authorization = 'Bearer fixture') => fetch(base + '/tenants', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authorization, 'Idempotency-Key': 'sample-key-01' },
    body: JSON.stringify(body),
  });
  const first = await send({ b: 2, a: 1 });
  const again = await send({ a: 1, b: 2 });
  assert.equal(first.status, 201);
  assert.equal(again.status, 201);
  assert.deepEqual((await first.json()).data, (await again.json()).data);
  assert.notEqual(first.headers.get('x-request-id'), again.headers.get('x-request-id'));
  await expectError(await send({ a: 2 }), 409, 'IDEMPOTENCY_CONFLICT');
  await expectError(await send({}, 'Bearer invalid'), 401, 'AUTHENTICATION_REQUIRED');
  allowed = false;
  await expectError(await send({ a: 1, b: 2 }), 404, 'NOT_FOUND');
  assert.equal(writes, 1);
  assert.equal(decisions, 4);
  assert.throws(() => createGateway({ routes: [{ id: 'createTenant', budget, handle() {}, authorize() {} }] }), /idempotency storage/);
});

test('a revision route requires a strong precondition and shows safe owner errors', async t => {
  const base = await start(t, {
    authenticate: () => ({ actor: 'fixture', scope: 'school' }),
    routes: [{
      id: 'updateRole', budget, authorize: () => true,
      handle({ ifMatch }) {
        if (ifMatch !== '"r1"') throw new GatewayError('PRECONDITION_FAILED');
        return { data: { revision: 'r2' }, etag: '"r2"' };
      },
    }],
  });
  const patch = tag => fetch(base + '/roles/example', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...tag ? { 'If-Match': tag } : {} },
    body: '{}',
  });
  await expectError(await patch(), 428, 'PRECONDITION_REQUIRED');
  await expectError(await patch('"old"'), 412, 'PRECONDITION_FAILED');
  const good = await patch('"r1"');
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('etag'), '"r2"');
});

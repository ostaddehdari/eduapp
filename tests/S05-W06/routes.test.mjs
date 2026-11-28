import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createGateway, GatewayError } from '../../apps/api-gateway/src/gateway.mjs';
import { createDelegationGatewayRoutes } from '../../apps/commerce-service/src/routes.mjs';

test('delegation API binds authenticated principal and denies spoofed tenant', async t => {
  const tenantA = randomUUID(), tenantB = randomUUID(), actor = randomUUID(), scopeOrgId = randomUUID();
  const seen = [];
  const service = {
    async request(input) { seen.push(input); return { id: randomUUID() }; },
    async decide(input) { seen.push(input); return { id: input.delegationId, approvedAt: new Date() }; },
    async canManage(input) { seen.push(input); return true; },
  };
  const server = createServer(createGateway({ authenticate: header => header === 'Bearer a'
    ? { tenantId: tenantA, scope: tenantA, actor } : header === 'Bearer b'
      ? { tenantId: tenantA, scope: tenantB, actor } : null,
  routes: createDelegationGatewayRoutes({ service, GatewayError }) }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}/v1/management/delegations`;
  const body = { tenantId: tenantB, identity: { actorId: randomUUID(), tenantId: tenantB },
    subscriptionId: randomUUID(), delegateIdentityId: randomUUID(), scopeOrgId, expiresAt: '2026-12-01T00:00:00Z', requestKey: randomUUID() };
  const post = (url, auth, data) => fetch(url, { method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await post(base, 'Bearer b', body)).status, 404);
  assert.equal((await post(base, 'Bearer missing', body)).status, 401);
  const requested = await post(base, 'Bearer a', body);
  assert.equal(requested.status, 201);
  assert.deepEqual(seen[0].identity, { tenantId: tenantA, scope: tenantA, actorId: actor });
  assert.equal(Object.hasOwn(seen[0], 'tenantId'), false);
  const id = (await requested.json()).data.id;
  assert.equal((await post(`${base}/${id}/decision`, 'Bearer a', { action: 'approve' })).status, 200);
  assert.equal(seen[1].identity.actorId, actor);
  const checked = await fetch(`${base}/access?scopeOrgId=${scopeOrgId}`, { headers: { authorization: 'Bearer a' } });
  assert.equal(checked.status, 200);
  assert.deepEqual((await checked.json()).data, { allowed: true });
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';
import { createGateway, GatewayError } from '../../apps/api-gateway/src/gateway.mjs';
import { createAccessRepository } from '../../apps/identity-service/src/people/access-repository.mjs';
import { createPeopleRoutes } from '../../apps/identity-service/src/people/gateway-routes.mjs';
import { createPeopleRepository } from '../../apps/identity-service/src/people/people-repository.mjs';
import { createPeopleService, hasPeopleScope } from '../../apps/identity-service/src/people/people-service.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';

const databaseUrl = process.env.EDUAPP_S03_W02_PG_ADMIN_URL;
const dbName = 'eduapp_s03_w02_test';

test('People adapters register the existing Gateway operations and reject a scope mismatch', async () => {
  const routes = createPeopleRoutes({ service: {}, GatewayError });
  assert.deepEqual(routes.map(route => route.id), ['listUsers', 'getUser', 'createUser', 'createMembership', 'createInvitation']);
  const mismatched = { actor: randomUUID(), scope: randomUUID(), tenantId: randomUUID(), membershipId: randomUUID() };
  assert.equal(hasPeopleScope(mismatched), false);
  assert.equal(await routes[0].authorize({ identity: mismatched }), false);
  assert.throws(() => createPeopleService({}), /owned authorization/);
});

test('two schools independently invite and resolve the same identity through PostgreSQL', {
  skip: !databaseUrl, timeout: 45_000,
}, async t => {
  let adminUrl;
  try { adminUrl = new URL(databaseUrl); } catch { throw new TypeError('Use a local PostgreSQL fixture URL'); }
  assert.ok(['postgres:', 'postgresql:'].includes(adminUrl.protocol), 'Use a PostgreSQL fixture URL');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname), 'Use a loopback fixture service');
  assert.ok(!adminUrl.search && !adminUrl.hash, 'Omit URL options and fragments');
  assert.equal(adminUrl.pathname, `/${dbName}`, 'Use the dedicated disposable database');
  const { Client, Pool } = createRequire(new URL('../../package.json', import.meta.url))('pg');
  const { runSqlBootstrap, applyTenantIsolation, applyAccessInvitations } = await import('../../packages/data/src/migrate.mjs');

  const setupUrl = new URL(adminUrl);
  setupUrl.pathname = '/postgres';
  const setup = new Client({ connectionString: setupUrl.href });
  await setup.connect();
  try {
    const result = await setup.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (!result.rowCount) await setup.query('CREATE DATABASE eduapp_s03_w02_test');
  } finally {
    await setup.end();
  }

  const admin = new Client({ connectionString: adminUrl.href });
  await admin.connect();
  const pools = [];
  t.after(async () => {
    await Promise.all(pools.map(pool => pool.end()));
    await admin.end();
  });
  await runSqlBootstrap(admin);

  async function roleUrl(role) {
    const password = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    const url = new URL(adminUrl);
    url.username = role;
    url.password = password;
    return url.href;
  }

  const migrator = new Client({ connectionString: await roleUrl('eduapp_schema_migrator') });
  await migrator.connect();
  try {
    await applyTenantIsolation(migrator);
    await applyAccessInvitations(migrator);
    assert.equal(await applyAccessInvitations(migrator), false);
  } finally {
    await migrator.end();
  }

  async function poolFor(role) {
    const pool = new Pool({ connectionString: await roleUrl(role), max: 2 });
    pools.push(pool);
    return pool;
  }
  const accessPool = await poolFor('eduapp_access_api');
  const access = createAccessRepository({ transactions: createTenantTransactions(accessPool) });
  const people = createPeopleRepository({ transactions: createTenantTransactions(await poolFor('eduapp_people_api')) });
  const iam = await poolFor('eduapp_iam_api');
  const findActiveIdentity = async ({ identityId }) => {
    const { rows } = await iam.query("SELECT id FROM identity_access.identities WHERE id = $1 AND status = 'active'", [identityId]);
    return rows[0] ?? null;
  };

  const [tenantA, tenantB, inviter, invitee, other, schoolA, schoolB] = Array.from({ length: 7 }, randomUUID);
  for (const tenant of [tenantA, tenantB]) {
    await admin.query("INSERT INTO tenancy_organization.tenants (id, slug, status) VALUES ($1, $2, 'active')", [tenant, `fixture-${tenant}`]);
  }
  for (const identity of [inviter, invitee, other]) {
    await admin.query("INSERT INTO identity_access.identities (id, login_normalized, status) VALUES ($1, $2, 'active')", [identity, `fixture-${identity}`]);
  }
  for (const [tenant, school] of [[tenantA, schoolA], [tenantB, schoolB]]) {
    await admin.query("INSERT INTO tenancy_organization.org_units (tenant_id, id, kind, code) VALUES ($1, $2, 'school', $3)", [tenant, school, `fixture-${school}`]);
  }

  const activeInviter = await Promise.all([tenantA, tenantB].map(async tenantId => {
    const { membershipId } = await access.addMembership({ tenantId, identityId: inviter, orgUnitId: null });
    return { actor: inviter, identityId: inviter, sessionId: randomUUID(), scope: tenantId, tenantId, membershipId };
  }));
  const receiver = { identityId: invitee, sessionId: randomUUID() };
  const mail = [];
  const delivery = async payload => { mail.push(payload); return true; };
  const actions = [];
  const serviceOptions = {
    access, people, findActiveIdentity, deliverInvitation: delivery,
    verifyOrgUnit: async ({ tenantId, orgUnitId }) => (tenantId === tenantA && orgUnitId === schoolA) || (tenantId === tenantB && orgUnitId === schoolB),
    authorize: async scope => { actions.push(scope.action); return scope.actor === inviter; },
  };
  const service = createPeopleService(serviceOptions);
  const create = (identity, orgUnitId) => service.createInvitation({ identity, body: { identityId: invitee, orgUnitId } });
  await assert.rejects(create(activeInviter[0], schoolB), { message: 'NOT_FOUND' });
  await assert.rejects(service.createInvitation({ identity: activeInviter[0], body: { identityId: invitee, tenantId: tenantB } }), { message: 'VALIDATION_FAILED' });
  const invitationA = await create(activeInviter[0], schoolA);
  const invitationB = await create(activeInviter[1], schoolB);
  assert.equal(invitationA.status, 'queued');
  assert.equal(invitationB.status, 'queued');
  assert.notEqual(invitationA.invitationId, invitationB.invitationId);
  assert.ok(!Object.hasOwn(invitationA, 'token'));
  assert.notEqual(mail[0].token, mail[1].token);
  assert.equal((await accessPool.query('SELECT id FROM identity_access.invitations')).rowCount, 0);
  const { rows: digests } = await admin.query('SELECT token_hash FROM identity_access.invitations WHERE id = ANY($1)', [[invitationA.invitationId, invitationB.invitationId]]);
  assert.equal(digests.length, 2);
  assert.ok(digests.every(row => row.token_hash.length === 32 && !mail.some(item => item.token === row.token_hash.toString('base64url'))));

  const accept = (tenantId, token, principal = receiver) => service.acceptInvitation({ principal, tenantId, token });
  await assert.rejects(accept(tenantB, mail[0].token), { message: 'NOT_FOUND' });
  await assert.rejects(accept(tenantA, mail[0].token, { identityId: other, sessionId: randomUUID() }), { message: 'NOT_FOUND' });
  const simultaneous = await Promise.allSettled([accept(tenantA, mail[0].token), accept(tenantA, mail[0].token)]);
  const [granted] = simultaneous.filter(result => result.status === 'fulfilled');
  assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(simultaneous.find(result => result.status === 'rejected').reason.message, 'NOT_FOUND');
  const a = granted.value;
  const b = await accept(tenantB, mail[1].token);
  assert.notEqual(a.membershipId, b.membershipId);
  assert.equal(a.orgUnitId, schoolA);
  assert.equal(b.orgUnitId, schoolB);
  assert.deepEqual(await service.selectContext({ principal: receiver, tenantId: tenantA, membershipId: a.membershipId }), a);
  assert.deepEqual(await service.selectContext({ principal: receiver, tenantId: tenantB, membershipId: b.membershipId }), b);
  await assert.rejects(service.selectContext({ principal: receiver, tenantId: tenantB, membershipId: a.membershipId }), { message: 'NOT_FOUND' });

  const expired = await create(activeInviter[0], null);
  await admin.query(`UPDATE identity_access.invitations SET created_at = statement_timestamp() - interval '3 days',
    expires_at = statement_timestamp() - interval '1 day' WHERE tenant_id = $1 AND id = $2`, [tenantA, expired.invitationId]);
  await assert.rejects(accept(tenantA, mail.at(-1).token), { message: 'NOT_FOUND' });
  const body = { identityId: invitee };
  const extra = await service.createMembership({ identity: activeInviter[0], body });
  assert.deepEqual(await service.createMembership({ identity: activeInviter[0], body }), extra);
  assert.equal(await access.resolveMembership({ tenantId: tenantA, identityId: invitee }), null);

  const profileA = await service.createUser({ identity: activeInviter[0], body: { identityId: invitee, displayName: 'Student A' } });
  const profileB = await service.createUser({ identity: activeInviter[1], body: { identityId: invitee, displayName: 'Student B' } });
  assert.deepEqual(Object.keys(profileA).sort(), ['displayName', 'id']);
  assert.notEqual(profileA.id, profileB.id);
  await assert.rejects(service.getUser({ identity: activeInviter[1], profileId: profileA.id }), { message: 'NOT_FOUND' });
  await assert.rejects(service.createUser({ identity: activeInviter[0], body: { identityId: invitee, displayName: 'Duplicate' } }), { message: 'CONFLICT' });
  await assert.rejects(service.listUsers({ identity: { ...activeInviter[0], actor: invitee, membershipId: a.membershipId }, page: { limit: 25 } }), { message: 'NOT_FOUND' });
  const { rows: outbox } = await admin.query("SELECT tenant_id, payload FROM platform_audit_jobs.outbox_events WHERE event_type = 'people.profile_changed.v1' AND tenant_id = ANY($1)", [[tenantA, tenantB]]);
  assert.equal(outbox.length, 2);
  assert.ok(outbox.every(event => event.payload.version === 1 && !Object.hasOwn(event.payload, 'display_name')));

  const failedPort = createPeopleService({ ...serviceOptions, deliverInvitation: async payload => { mail.push(payload); return false; } });
  await assert.rejects(failedPort.createInvitation({ identity: activeInviter[0], body: { identityId: invitee } }), { message: 'SERVICE_UNAVAILABLE' });
  await assert.rejects(accept(tenantA, mail.at(-1).token), { message: 'NOT_FOUND' });

  const gateway = createGateway({
    authenticate: async value => activeInviter[value === 'Bearer A' ? 0 : value === 'Bearer B' ? 1 : -1],
    routes: createPeopleRoutes({ service, GatewayError }),
  });
  const server = createServer(gateway).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${server.address().port}/v1/users`;
  const r = await globalThis.fetch(url, { headers: { authorization: 'Bearer A', 'x-tenant-id': tenantB } });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).data, [profileA]);
  assert.equal((await globalThis.fetch(`${url}/${profileA.id}`, { headers: { authorization: 'Bearer B' } })).status, 404);
  assert.ok(actions.includes('access.invitation.create') && actions.includes('people.user.read'));
});

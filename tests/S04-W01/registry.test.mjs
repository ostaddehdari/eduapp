import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import { createTenantRegistry } from '../../apps/tenant-org-service/src/registry.mjs';
import {
  applyAccessInvitations, applyAccessPolicy, applyTenantIsolation, applyTenantRegistry, runSqlBootstrap,
} from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';

const fixtureName = 'eduapp_s04_registry_test';
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  assert(process.env.EDUAPP_S04_REGISTRY_PG_ADMIN_URL, 'Set EDUAPP_S04_REGISTRY_PG_ADMIN_URL');
  const url = new URL(process.env.EDUAPP_S04_REGISTRY_PG_ADMIN_URL);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/' + fixtureName);
  assert.equal(url.search, '');
  const connect = async (connectionString) => {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 3000 });
    await client.connect();
    t.after(() => client.end());
    return client;
  };
  const base = new URL(url);
  base.pathname = '/postgres';
  const maintenance = await connect(base.href);
  const exists = await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [fixtureName]);
  if (!exists.rowCount) await maintenance.query('CREATE DATABASE ' + fixtureName);
  const admin = await connect(url.href);
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);
  const credentials = new Map();
  for (const role of ['eduapp_schema_migrator', 'eduapp_tenancy_api', 'eduapp_access_api']) {
    const secret = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${secret}'`);
    const roleUrl = new URL(url);
    roleUrl.username = role;
    roleUrl.password = secret;
    credentials.set(role, roleUrl.href);
  }
  const migrator = await connect(credentials.get('eduapp_schema_migrator'));
  await applyTenantIsolation(migrator);
  await applyAccessInvitations(migrator);
  await applyAccessPolicy(migrator);
  await applyTenantRegistry(migrator);
  assert.equal(await applyTenantRegistry(migrator), false);
  const pool = role => {
    const value = new pg.Pool({ connectionString: credentials.get(role), connectionTimeoutMillis: 3000, max: 4 });
    t.after(() => value.end());
    return value;
  };
  return { admin, tenancy: pool('eduapp_tenancy_api'), access: pool('eduapp_access_api') };
}

test('Tenant Registry commits and isolates real PostgreSQL handoffs', { timeout: 30_000 }, async (t) => {
  const { admin, tenancy, access } = await fixture(t);
  const transactions = createTenantTransactions(tenancy);
  const accessTx = createTenantTransactions(access);
  const platformAdmin = { actor: randomUUID(), scope: 'identity-bootstrap' };
  const buyer = { actor: randomUUID(), scope: 'identity-bootstrap' };
  const outsider = { actor: randomUUID(), scope: 'identity-bootstrap' };
  const ownerId = randomUUID();
  const secondOwnerId = randomUUID();
  const disabledId = randomUUID();
  for (const [id, status] of [[ownerId, 'active'], [secondOwnerId, 'active'], [disabledId, 'disabled']]) {
    await admin.query('INSERT INTO identity_access.identities (id, login_normalized, status) VALUES ($1,$2,$3)',
      [id, id + '@example.test', status]);
  }
  const verifiedPayment = randomUUID();
  let clock = Date.now();
  const registry = createTenantRegistry({
    transactions, now: () => clock,
    authorizeProvisioning: ({ identity }) => {
      if (identity.actor === platformAdmin.actor) return { kind: 'platform_admin' };
      if (identity.actor === buyer.actor) return { kind: 'verified_payment', reference: verifiedPayment };
      return null;
    },
    authorizeTenant: async ({ identity, tenantId }) => {
      const value = await accessTx.run(tenantId, db => db.query(`
        SELECT 1 FROM identity_access.memberships AS m
        JOIN identity_access.role_bindings AS b ON b.tenant_id = m.tenant_id AND b.membership_id = m.id
        JOIN identity_access.roles AS r ON r.tenant_id = b.tenant_id AND r.id = b.role_id
        WHERE m.id = $1 AND m.identity_id = $2 AND m.status = 'active' AND r.builtin
      `, [identity.membershipId, identity.actor]));
      return value.rowCount === 1;
    },
    authorizeStatusChange: ({ identity }) => identity.actor === platformAdmin.actor,
  });

  function body(ownerIdentityId = ownerId, trialDays = undefined) {
    return {
      slug: 'test-' + randomUUID(), displayName: 'Fixture school', ownerIdentityId,
      legalEntity: { name: 'Synthetic Organization', countryCode: 'IR', registrationNumber: 'synthetic-ref' },
      ...(trialDays === undefined ? {} : { trialDays }),
    };
  }
  function command(value, identity = platformAdmin, key = randomUUID()) {
    return { body: value, identity, requestId: randomUUID(),
      idempotency: { namespace: [identity.scope, identity.actor, 'createTenant', key], fingerprint: sha(JSON.stringify(value)) } };
  }
  function scoped(registration) {
    return { actor: registration.ownerIdentityId, tenantId: registration.id,
      membershipId: registration.ownerMembershipId, scope: registration.id };
  }
  let a, b, createA;

  await t.test('authorizes provisioning and commits legal entity, owner, receipt, audit and event together', async () => {
    const value = body(ownerId, 10);
    await assert.rejects(registry.create(command(value, outsider)), { code: 'FORBIDDEN' });
    await assert.rejects(registry.create(command({ ...value, trialDays: 31 })), { code: 'VALIDATION_FAILED' });
    await assert.rejects(registry.create(command({ ...value, verifiedPayment })), { code: 'VALIDATION_FAILED' });
    createA = command(value);
    const [left, right] = await Promise.all([registry.create(createA), registry.create({ ...createA, requestId: randomUUID() })]);
    a = left;
    assert.deepEqual(left, right);
    assert.equal(a.status, 'active');
    assert.equal(a.version, 1);
    assert.deepEqual(a.legalEntity, value.legalEntity);
    assert.equal(Date.parse(a.trialEndsAt) - Date.parse(a.createdAt), 10 * 86_400_000);
    const owned = await admin.query(`
      SELECT m.id, m.identity_id, m.org_unit_id, r.name, r.builtin, r.rules
      FROM identity_access.memberships m
      JOIN identity_access.registry_owner_receipts receipt ON receipt.tenant_id = m.tenant_id AND receipt.membership_id = m.id
      JOIN identity_access.role_bindings b ON b.tenant_id = m.tenant_id AND b.membership_id = m.id
      JOIN identity_access.roles r ON r.tenant_id = b.tenant_id AND r.id = b.role_id
      WHERE m.tenant_id = $1
    `, [a.id]);
    assert.equal(owned.rowCount, 1);
    assert.equal(owned.rows[0].id, a.ownerMembershipId);
    assert.equal(owned.rows[0].identity_id, ownerId);
    assert.equal(owned.rows[0].org_unit_id, null);
    assert.equal(owned.rows[0].builtin, true);
    assert.deepEqual(owned.rows[0].rules.map(r => r.action).sort(),
      ['tenancy.org.read', 'tenancy.org.write', 'tenancy.tenant.read']);
    const event = await admin.query('SELECT event_type, payload FROM platform_audit_jobs.outbox_events WHERE tenant_id = $1', [a.id]);
    assert.deepEqual(event.rows, [{ event_type: 'tenancy.tenant_created.v1', payload: { tenantId: a.id } }]);
    const audit = await admin.query(`
      SELECT actor_id, request_id, action FROM tenancy_organization.registry_audit_facts WHERE tenant_id = $1
    `, [a.id]);
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].actor_id, platformAdmin.actor);
    assert.equal(audit.rows[0].action, 'tenant_created');
    assert.match(audit.rows[0].request_id, /^[a-f0-9-]{36}$/);
  });

  await t.test('rejects conflicting commands, duplicate slug and payment redemptions with no partial result', async () => {
    const changed = { ...createA.body, displayName: 'Different fixture body' };
    await assert.rejects(registry.create({ ...createA, body: changed }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(registry.create(command(createA.body)), { code: 'CONFLICT' });
    const unavailable = body(disabledId);
    await assert.rejects(registry.create(command(unavailable)), { code: 'VALIDATION_FAILED' });
    assert.equal((await admin.query('SELECT 1 FROM tenancy_organization.tenants WHERE slug = $1', [unavailable.slug])).rowCount, 0);
    b = await registry.create(command(body(secondOwnerId), buyer));
    assert.equal(b.ownerIdentityId, secondOwnerId);
    assert.equal(b.trialEndsAt, null);
    const duplicate = body(secondOwnerId);
    await assert.rejects(registry.create(command(duplicate, buyer)), { code: 'CONFLICT' });
    assert.equal((await admin.query('SELECT 1 FROM tenancy_organization.tenants WHERE slug = $1', [duplicate.slug])).rowCount, 0);
    const stored = (await admin.query(`
      SELECT payment_reference_digest FROM tenancy_organization.registry_create_commands WHERE tenant_id = $1
    `, [b.id])).rows[0];
    assert.equal(stored.payment_reference_digest, sha(verifiedPayment));
    await assert.rejects(transactions.run(a.id, db => db.query(
      'SELECT identity_access.bootstrap_registry_owner($1)', [secondOwnerId],
    )), { code: '42501' });
  });

  await t.test('scopes list and detail and prevents direct reads of foreign ownership and audit rows', async () => {
    const requestId = randomUUID();
    const aScope = scoped(a);
    assert.deepEqual(await registry.get({ identity: aScope, tenantId: a.id, requestId }), a);
    await assert.rejects(registry.get({ identity: aScope, tenantId: b.id, requestId }), { code: 'NOT_FOUND' });
    const page = { limit: 20, position: null };
    assert.deepEqual(await registry.list({ identity: aScope, requestId, page }), { data: [a], nextPosition: null });
    assert.deepEqual(await registry.list({ identity: platformAdmin, requestId, page }), { data: [], nextPosition: null });
    await assert.rejects(tenancy.query('SELECT * FROM identity_access.memberships'), { code: '42501' });
    assert.equal((await tenancy.query('SELECT * FROM tenancy_organization.registry_audit_facts')).rowCount, 0);
    const blocked = await transactions.run(a.id, (db) => db.query(
      'SELECT * FROM tenancy_organization.legal_entities WHERE tenant_id = $1', [b.id],
    ));
    assert.equal(blocked.rowCount, 0);
  });

  await t.test('suspends and reactivates with compare and swap and an append-only audit trail', async () => {
    const aScope = scoped(a);
    const update = (status, expectedVersion, identity = platformAdmin) =>
      registry.setStatus({ identity, tenantId: a.id, requestId: randomUUID(), body: { status, expectedVersion } });
    assert.equal(await registry.isActive(a.id), true);
    await assert.rejects(update('suspended', 1, aScope), { code: 'FORBIDDEN' });
    clock += 1000;
    const suspended = await update('suspended', 1);
    assert.equal(suspended.status, 'suspended');
    assert.equal(suspended.version, 2);
    assert.equal(await registry.isActive(a.id), false);
    assert.equal(await registry.isActive(b.id), true);
    await assert.rejects(registry.get({ identity: aScope, tenantId: a.id, requestId: randomUUID() }), { code: 'NOT_FOUND' });
    await assert.rejects(update('active', 1), { code: 'PRECONDITION_FAILED' });
    assert.deepEqual(await update('suspended', 2), suspended);
    assert.deepEqual(await registry.create(createA), a);
    clock += 1000;
    const reactivated = await update('active', 2);
    assert.equal(reactivated.status, 'active');
    assert.equal(reactivated.version, 3);
    assert.equal(await registry.isActive(a.id), true);
    const audit = (await admin.query(`
      SELECT action FROM tenancy_organization.registry_audit_facts WHERE tenant_id = $1 ORDER BY occurred_at
    `, [a.id])).rows;
    assert.deepEqual(audit.map(row => row.action), ['tenant_created', 'tenant_suspended', 'tenant_reactivated']);
    await assert.rejects(transactions.run(a.id, db => db.query(
      'DELETE FROM tenancy_organization.registry_audit_facts WHERE tenant_id = $1', [a.id],
    )), { code: '42501' });
  });
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import {
  applyAccessInvitations, applyAccessPolicy, applyOrganizationTree, applyScopedOrgManagement,
  applyTenantIsolation, applyTenantRegistry, runSqlBootstrap,
} from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';
import { createOrganizationTree } from '../../apps/tenant-org-service/src/tree.mjs';

const config = process.env.EDUAPP_S04_ORG_PG_ADMIN_URL;
const fixtureActor = randomUUID();
const principal = tenantId => ({ actor: fixtureActor, scope: tenantId, tenantId, membershipId: randomUUID() });

test('organization tree transactionally isolates schools and rejects invalid concurrent moves', {
  timeout: 30_000,
}, async t => {
  assert(config, 'Set EDUAPP_S04_ORG_PG_ADMIN_URL for disposable PostgreSQL 17');
  const url = new URL(config);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s04_org_test');
  assert.equal(url.search + url.hash, '');
  const provisioner = new pg.Client({ connectionString: new URL('/postgres', url).href, connectionTimeoutMillis: 3000 });
  await provisioner.connect();
  try {
    const exists = await provisioner.query("SELECT 1 FROM pg_database WHERE datname = 'eduapp_s04_org_test'");
    if (!exists.rowCount) await provisioner.query('CREATE DATABASE eduapp_s04_org_test');
  } finally {
    await provisioner.end();
  }
  const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  await admin.connect();
  t.after(() => admin.end());
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);

  async function roleUrl(role) {
    const password = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    const credentials = new URL(url);
    credentials.username = role;
    credentials.password = password;
    return credentials.href;
  }
  const migrator = new pg.Client({ connectionString: await roleUrl('eduapp_schema_migrator'), connectionTimeoutMillis: 3000 });
  await migrator.connect();
  const a = principal(randomUUID());
  const b = principal(randomUUID());
  let legacyId;
  try {
    await applyTenantIsolation(migrator);
    await applyAccessInvitations(migrator);
    await applyAccessPolicy(migrator);
    await applyTenantRegistry(migrator);
    for (const identity of [a, b]) {
      await admin.query("INSERT INTO tenancy_organization.tenants (id,slug,status) VALUES ($1,$2,'active')",
        [identity.tenantId, identity.tenantId]);
    }
    const legacy = await admin.query(`
      INSERT INTO tenancy_organization.org_units (tenant_id,kind,code)
      VALUES ($1,'school','legacy') RETURNING id
    `, [a.tenantId]);
    legacyId = legacy.rows[0].id;
    await applyOrganizationTree(migrator);
    await applyScopedOrgManagement(migrator);
    assert.equal(await applyOrganizationTree(migrator), false);
  } finally {
    await migrator.end();
  }

  const pool = new pg.Pool({ connectionString: await roleUrl('eduapp_tenancy_api'), max: 4, connectionTimeoutMillis: 3000 });
  t.after(() => pool.end());
  const tree = createOrganizationTree({
    transactions: createTenantTransactions(pool),
    authorize: async ({ identity, tenantId, orgUnitId }) =>
      [a, b].some(candidate => candidate.tenantId === tenantId && candidate.membershipId === identity.membershipId) && orgUnitId === null,
  });
  const page = { limit: 100 };
  const list = (identity, currentPage = page) => tree.list({ identity, page: currentPage });
  function create(identity, kind, code, parentId = null, key = randomUUID()) {
    return tree.create({
      identity, body: { kind, code, name: 'Fixture ' + code, parentId, idempotencyKey: key },
    });
  }
  const move = (identity, node, parentId, version = node.version) => tree.move({
    identity, orgUnitId: node.orgUnitId, ifMatch: '"' + version + '"', body: { parentId },
  });
  const eventRows = identity => admin.query(`
    SELECT payload FROM platform_audit_jobs.outbox_events
    WHERE tenant_id = $1 AND event_type = 'tenancy.org_unit_changed.v1'
  `, [identity.tenantId]).then(({ rows }) => rows.map(row => row.payload));

  const legacy = (await list(a)).data[0];
  assert.deepEqual(legacy, { orgUnitId: legacyId, parentId: null, kind: 'school', code: 'legacy', name: 'legacy', version: 1 });
  const holding = await create(a, 'holding', 'holding');
  const company = await create(a, 'company', 'company', holding.orgUnitId);
  const collection = await create(a, 'collection', 'group', company.orgUnitId);
  const branch = await create(a, 'branch', 'branch', collection.orgUnitId);
  const school = await create(a, 'school', 'campus', branch.orgUnitId);
  assert.equal(school.parentId, branch.orgUnitId);
  const institute = await create(a, 'institute', 'institute', branch.orgUnitId);
  assert.equal(institute.kind, 'institute');
  const replayKey = randomUUID();
  const duplicate = await Promise.all([
    create(a, 'school', 'independent', null, replayKey),
    create(a, 'school', 'independent', null, replayKey),
  ]);
  assert.deepEqual(duplicate[0], duplicate[1]);
  const standalone = duplicate[0];
  const tenantB = await create(b, 'school', 'independent', null, replayKey);
  assert.notEqual(standalone.orgUnitId, tenantB.orgUnitId);
  await assert.rejects(create(a, 'school', 'modified', null, replayKey), { message: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(create(a, 'school', 'independent'), { message: 'ORG_CODE_CONFLICT' });
  await assert.rejects(create(a, 'school', 'campus', branch.orgUnitId), { message: 'ORG_CODE_CONFLICT' });
  await assert.rejects(create(a, 'branch', 'misplaced', school.orgUnitId), { message: 'VALIDATION_FAILED' });
  await assert.rejects(create(a, 'branch', 'foreign-parent', tenantB.orgUnitId), { message: 'ORG_PARENT_NOT_FOUND' });
  await assert.rejects(create(a, 'branch', 'missing-parent', randomUUID()), { message: 'ORG_PARENT_NOT_FOUND' });
  await assert.rejects(move(a, tenantB, null), { message: 'NOT_FOUND' });
  await assert.rejects(move(a, school, tenantB.orgUnitId), { message: 'ORG_PARENT_NOT_FOUND' });
  assert.deepEqual((await list(b)).data, [tenantB]);
  const directSchool = await move(a, school, collection.orgUnitId);
  assert.equal(directSchool.parentId, collection.orgUnitId);
  assert.equal(directSchool.version, 2);

  const firstPage = await list(a, { limit: 1 });
  const rest = await list(a, { limit: 100, position: firstPage.nextPosition });
  assert.equal(firstPage.nextPosition, firstPage.data[0].orgUnitId);
  assert.equal(rest.nextPosition, null);
  assert.equal(firstPage.data.length + rest.data.length, 8);

  const parents = await Promise.all(['first-group', 'second-group'].map(code => create(a, 'collection', code)));
  const cycleRace = await Promise.allSettled([
    move(a, parents[0], parents[1].orgUnitId),
    move(a, parents[1], parents[0].orgUnitId),
  ]);
  assert.equal(cycleRace.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(cycleRace.find(item => item.status === 'rejected').reason.message, 'ORG_CYCLE');
  const [branch2, branch3] = await Promise.all(parents.map(parent => create(a, 'branch', 'branch', parent.orgUnitId)));
  const staleRace = await Promise.allSettled([move(a, standalone, branch2.orgUnitId), move(a, standalone, branch3.orgUnitId)]);
  assert.equal(staleRace.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(staleRace.find(item => item.status === 'rejected').reason.message, 'PRECONDITION_FAILED');
  const moved = staleRace.find(item => item.status === 'fulfilled').value;
  assert.equal(moved.version, 2);
  assert.deepEqual(await move(a, moved, moved.parentId), moved);
  assert.deepEqual(await create(a, 'school', 'independent', null, replayKey), standalone);

  const persisted = (await eventRows(a)).filter(item => item.org_unit_id === standalone.orgUnitId)
    .sort((first, second) => first.version - second.version);
  assert.deepEqual(persisted, [
    { org_unit_id: standalone.orgUnitId, version: 1 }, { org_unit_id: standalone.orgUnitId, version: 2 },
  ]);
  assert.deepEqual(await eventRows(b), [{ org_unit_id: tenantB.orgUnitId, version: 1 }]);

  // A native outbox privilege failure must roll back the new node and its receipt.
  const signature = 'platform_audit_jobs.append_outbox(uuid, text, jsonb)';
  await admin.query('REVOKE EXECUTE ON FUNCTION ' + signature + ' FROM eduapp_tenancy_api');
  const failedKey = randomUUID();
  try {
    await assert.rejects(create(a, 'school', 'rolled-back', null, failedKey), { code: '42501' });
    assert.equal((await list(a)).data.some(item => item.code === 'rolled-back'), false);
  } finally {
    await admin.query('GRANT EXECUTE ON FUNCTION ' + signature + ' TO eduapp_tenancy_api');
  }
  const recovered = await create(a, 'school', 'rolled-back', null, failedKey);
  assert.deepEqual((await eventRows(a)).filter(item => item.org_unit_id === recovered.orgUnitId),
    [{ org_unit_id: recovered.orgUnitId, version: 1 }]);

  await admin.query("UPDATE tenancy_organization.tenants SET status='suspended' WHERE id=$1", [a.tenantId]);
  await assert.rejects(list(a), { message: 'NOT_FOUND' });
  await assert.rejects(create(a, 'school', 'suspended'), { message: 'NOT_FOUND' });
  await assert.rejects(move(a, moved, null), { message: 'NOT_FOUND' });
  assert.deepEqual((await list(b)).data, [tenantB]);
});

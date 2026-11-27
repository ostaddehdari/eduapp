import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from 'pg';
import {
  applyAccessPolicy, applyTenantIsolation, runSqlBootstrap,
} from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';
import { createAccessRepository } from '../../apps/identity-service/src/people/access-repository.mjs';
import { createPostgresAccessRepository } from '../../apps/identity-service/src/access/repository.mjs';
import { createAccessService } from '../../apps/identity-service/src/access/service.mjs';

const config = process.env.EDUAPP_S03_ACCESS_PG_ADMIN_URL;
const allow = (action, fields = []) => ({ action, effect: 'allow', fields });

test('native PostgreSQL persists access roles and denies expired or foreign assignments', {
  skip: !config, timeout: 30_000,
}, async t => {
  const url = new URL(config);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s03_access_test');
  assert.equal(url.search + url.hash, '');
  const maintenance = new URL(url);
  maintenance.pathname = '/postgres';
  const provisioner = new pg.Client({ connectionString: maintenance.href, connectionTimeoutMillis: 3000 });
  await provisioner.connect();
  try {
    const found = await provisioner.query('SELECT 1 FROM pg_database WHERE datname = $1', ['eduapp_s03_access_test']);
    if (!found.rowCount) await provisioner.query('CREATE DATABASE eduapp_s03_access_test');
  } finally {
    await provisioner.end();
  }
  const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  await admin.connect();
  t.after(() => admin.end());
  const { rows: [version] } = await admin.query('SHOW server_version_num');
  assert.match(version.server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);

  const login = async (role) => {
    const password = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    const scoped = new URL(url);
    scoped.username = role;
    scoped.password = password;
    return scoped.href;
  };
  const accessUrl = await login('eduapp_access_api');
  const migrator = new pg.Client({ connectionString: await login('eduapp_schema_migrator'), connectionTimeoutMillis: 3000 });
  await migrator.connect();
  try {
    await applyTenantIsolation(migrator);
    await applyAccessPolicy(migrator);
    assert.equal(await applyAccessPolicy(migrator), false);
  } finally {
    await migrator.end();
  }

  const pool = new pg.Pool({ connectionString: accessUrl, max: 1 });
  t.after(() => pool.end());
  const transactions = createTenantTransactions(pool);
  const repository = createPostgresAccessRepository({ transactions });
  const memberships = createAccessRepository({ transactions });
  const a = { tenantId: randomUUID(), branch: randomUUID(), learnerId: randomUUID(), learner: randomUUID() };
  const b = { tenantId: randomUUID(), branch: randomUUID(), learnerId: randomUUID(), learner: randomUUID() };
  const actor = randomUUID();
  const membershipId = randomUUID();
  for (const school of [a, b]) {
    await admin.query("INSERT INTO tenancy_organization.tenants (id,slug,status) VALUES ($1,$2,'active')",
      [school.tenantId, school.tenantId]);
    await admin.query(`
      INSERT INTO identity_access.memberships (tenant_id,id,identity_id,org_unit_id,status) VALUES ($1,$2,$3,$4,'active')
    `, [school.tenantId, school.learnerId, school.learner, school.branch]);
  }
  await admin.query("INSERT INTO identity_access.memberships (tenant_id,id,identity_id,status) VALUES ($1,$2,$3,'active')",
    [a.tenantId, membershipId, actor]);
  const management = [
    allow('access.role.read'), allow('access.role.write'),
    allow('access.role.assign'), allow('school.student.read', ['studentId', 'displayName']),
  ];
  const { rows: [builtin] } = await admin.query(`
    INSERT INTO identity_access.roles (tenant_id,name,version,rules,builtin)
    VALUES ($1,'Fixture manager',1,$2::jsonb,true) RETURNING id
  `, [a.tenantId, JSON.stringify(management)]);
  await admin.query(`
    INSERT INTO identity_access.role_bindings (tenant_id,membership_id,role_id) VALUES ($1,$2,$3)
  `, [a.tenantId, membershipId, builtin.id]);

  const access = createAccessService({
    repository, resolveMembership: memberships.resolveMembership,
    verifyOrgUnit: async ({ tenantId, orgUnitId }) => tenantId === a.tenantId && [a.branch, b.branch].includes(orgUnitId),
    requireRecentMfa: async identity => identity.actor === actor,
  });
  const principal = { actor, tenantId: a.tenantId, scope: a.tenantId, membershipId };
  const roleDef = { name: 'Fixture reader', rules: [allow('school.student.read', ['studentId'])] };
  const role = await access.createRole(principal, roleDef);
  await assert.rejects(access.updateRole(principal, builtin.id, '"1"', roleDef), { message: 'NOT_FOUND' });
  const firstPage = await access.listRoles(principal, { limit: 1, position: null });
  assert.equal(firstPage.data.length, 1);
  assert(firstPage.nextPosition);
  const secondPage = await access.listRoles(principal, { limit: 1, position: firstPage.nextPosition });
  assert.equal(secondPage.nextPosition, null);
  assert.deepEqual(new Set([...firstPage.data, ...secondPage.data].map(row => row.roleId)), new Set([builtin.id, role.roleId]));

  const body = { roleId: role.roleId, membershipId: a.learnerId, orgUnitId: a.branch };
  const first = await access.assignRole(principal, body);
  assert.equal((await access.assignRole(principal, body)).roleBindingId, first.roleBindingId);
  await assert.rejects(access.assignRole(principal, {
    ...body, membershipId: b.learnerId, orgUnitId: b.branch,
  }), { message: 'NOT_FOUND' });
  await assert.rejects(access.assignRole(principal, { ...body, orgUnitId: b.branch }), { message: 'NOT_FOUND' });
  const target = { action: 'school.student.read', tenantId: a.tenantId, orgUnitId: a.branch };
  const learner = { actor: a.learner, tenantId: a.tenantId, scope: a.tenantId, membershipId: a.learnerId };
  assert.deepEqual(await access.decide(learner, target), { allowed: true, fields: ['studentId'] });
  assert.equal(await access.can(learner, { ...target, orgUnitId: b.branch }), false);
  assert.equal(await access.can(learner, { ...target, tenantId: b.tenantId, orgUnitId: b.branch }), false);
  assert.equal(await repository.getRole({ tenantId: b.tenantId, roleId: role.roleId }), null);

  const changed = await access.updateRole(principal, role.roleId, '"1"', {
    ...roleDef, rules: [...roleDef.rules, { action: 'school.student.read', effect: 'deny' }],
  });
  assert.equal(changed.version, 2);
  await assert.rejects(access.updateRole(principal, role.roleId, '"1"', roleDef), { message: 'PRECONDITION_FAILED' });
  assert.equal(await access.can(learner, target), false);
  await access.updateRole(principal, role.roleId, '"2"', roleDef);
  assert.equal(await access.can(learner, target), true);
  await admin.query(
    "UPDATE identity_access.role_bindings SET expires_at = statement_timestamp() - interval '1 second' WHERE tenant_id = $1 AND id = $2",
    [a.tenantId, first.roleBindingId],
  );
  assert.equal(await access.can(learner, target), false);
});

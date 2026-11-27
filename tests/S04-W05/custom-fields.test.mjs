import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import pg from 'pg';
import { createGateway, GatewayError } from '../../apps/api-gateway/src/gateway.mjs';
import { createCustomFieldsRoutes } from '../../apps/custom-fields/src/routes.mjs';
import { createCustomFields } from '../../apps/custom-fields/src/service.mjs';
import { createPostgresAccessRepository } from '../../apps/identity-service/src/access/repository.mjs';
import { createAccessService } from '../../apps/identity-service/src/access/service.mjs';
import { createAccessRepository } from '../../apps/identity-service/src/people/access-repository.mjs';
import {
  applyAccessInvitations, applyAccessPolicy, applyCustomFields, applyOnboarding, applyOrganizationTree,
  applyScopedOrgManagement, applyTenantIsolation, applyTenantRegistry, runSqlBootstrap,
} from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';

const fixtureName = 'eduapp_s04_fields_test';

async function setup(t) {
  assert(process.env.EDUAPP_S04_FIELDS_PG_ADMIN_URL, 'Set EDUAPP_S04_FIELDS_PG_ADMIN_URL');
  const url = new URL(process.env.EDUAPP_S04_FIELDS_PG_ADMIN_URL);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/' + fixtureName);
  assert.equal(url.search, '');
  const connect = async (connectionString) => {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 3000 });
    await client.connect();
    t.after(() => client.end());
    return client;
  };
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  const maintenance = await connect(maintenanceUrl.href);
  if (!(await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [fixtureName])).rowCount) {
    await maintenance.query('CREATE DATABASE ' + fixtureName);
  }
  const admin = await connect(url.href);
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);
  const credentials = new Map();
  for (const role of ['eduapp_schema_migrator', 'eduapp_fields_api', 'eduapp_access_api']) {
    const secret = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${secret}'`);
    const roleUrl = new URL(url);
    roleUrl.username = role;
    roleUrl.password = secret;
    credentials.set(role, roleUrl.href);
  }
  const migrator = await connect(credentials.get('eduapp_schema_migrator'));
  for (const apply of [applyTenantIsolation, applyAccessInvitations, applyAccessPolicy, applyTenantRegistry,
    applyOrganizationTree, applyScopedOrgManagement, applyOnboarding, applyCustomFields]) {
    await apply(migrator);
  }
  assert.equal(await applyCustomFields(migrator), false);
  const pool = (role) => {
    const handle = new pg.Pool({ connectionString: credentials.get(role), connectionTimeoutMillis: 3000, max: 4 });
    t.after(() => handle.end());
    return handle;
  };
  return { admin, fieldsPool: pool('eduapp_fields_api'), accessPool: pool('eduapp_access_api') };
}

test('versioned school and student fields on native PostgreSQL', { timeout: 30_000 }, async (t) => {
  const { admin, fieldsPool, accessPool } = await setup(t);
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  for (const tenantId of [tenantA, tenantB]) {
    await admin.query("INSERT INTO tenancy_organization.tenants (id, slug, status) VALUES ($1,$2,'active')",
      [tenantId, 'fixture-' + tenantId]);
  }
  const studentId = randomUUID();
  async function seedSchool(tenantId) {
    const schoolId = randomUUID();
    const orgUnitId = randomUUID();
    const yearId = randomUUID();
    await admin.query(`
      INSERT INTO tenancy_organization.org_units (tenant_id,id,kind,code) VALUES ($1,$2,'school',$3)
    `, [tenantId, orgUnitId, orgUnitId]);
    await admin.query('INSERT INTO school_enrollment.schools (tenant_id,id,org_unit_id) VALUES ($1,$2,$3)',
      [tenantId, schoolId, orgUnitId]);
    await admin.query(`
      INSERT INTO school_enrollment.academic_years (tenant_id,id,school_id,starts_on,ends_on)
      VALUES ($1,$2,$3,'2026-09-01','2027-07-01')
    `, [tenantId, yearId, schoolId]);
    await admin.query(`
      INSERT INTO school_enrollment.enrollments (tenant_id,school_id,year_id,student_person_id,status)
      VALUES ($1,$2,$3,$4,'active')
    `, [tenantId, schoolId, yearId, studentId]);
    return { schoolId, orgUnitId };
  }
  const a = await seedSchool(tenantA);
  const aSecond = await seedSchool(tenantA);
  const b = await seedSchool(tenantB);

  async function principal(tenantId, orgUnitId, actions) {
    const actor = randomUUID();
    const membershipId = randomUUID();
    const roleId = randomUUID();
    await admin.query(`
      INSERT INTO identity_access.memberships (tenant_id,id,identity_id,org_unit_id,status)
      VALUES ($1,$2,$3,$4,'active')
    `, [tenantId, membershipId, actor, orgUnitId]);
    const rules = actions.map(action => ({ action, effect: 'allow', relationship: null, fields: [] }));
    await admin.query(`
      INSERT INTO identity_access.roles (tenant_id,id,name,version,rules) VALUES ($1,$2,$3,1,$4::jsonb)
    `, [tenantId, roleId, roleId, JSON.stringify(rules)]);
    await admin.query(`
      INSERT INTO identity_access.role_bindings (tenant_id,membership_id,role_id,scope_org_id)
      VALUES ($1,$2,$3,$4)
    `, [tenantId, membershipId, roleId, orgUnitId]);
    return { actor, tenantId, scope: tenantId, membershipId, orgUnitId };
  }
  const managerActions = ['fields.definition.read', 'fields.definition.write', 'fields.school.read', 'fields.school.write'];
  const childActions = ['fields.definition.read', 'fields.student.read', 'fields.student.write'];
  const managerA = await principal(tenantA, null, managerActions);
  const managerB = await principal(tenantB, null, managerActions);
  const studentA = await principal(tenantA, a.orgUnitId, childActions);
  const studentASecond = await principal(tenantA, aSecond.orgUnitId, childActions);
  const accessTx = createTenantTransactions(accessPool);
  const access = createAccessRepository({ transactions: accessTx });
  const permissions = createAccessService({
    repository: createPostgresAccessRepository({ transactions: accessTx }), resolveMembership: access.resolveMembership,
  });
  const fields = createCustomFields({
    transactions: createTenantTransactions(fieldsPool),
    authorize: ({ identity, ...target }) => permissions.can(identity, target),
  });
  const bearer = new Map([
    ['Bearer admin-a', managerA], ['Bearer admin-b', managerB], ['Bearer student-a', studentA],
    ['Bearer student-a-second', studentASecond],
  ]);
  const gateway = createServer(createGateway({
    authenticate: async header => bearer.get(header),
    routes: createCustomFieldsRoutes({ fields, GatewayError }),
  }));
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => gateway.close(error => error ? reject(error) : resolve())));
  async function request(path, who, body) {
    const headers = { Authorization: 'Bearer ' + who };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const result = await fetch('http://127.0.0.1:' + gateway.address().port + '/v1' + path, {
      method: body === undefined ? 'GET' : 'POST', headers, body: JSON.stringify(body),
    });
    return { status: result.status, headers: result.headers, ...(await result.json()) };
  }
  const publish = (who, body) => request('/field-definitions', who, body);
  const schoolPath = school => '/field-values/school/' + school;
  const studentPath = school => '/field-values/student/' + studentId + '?schoolId=' + school;
  const schoolDefinition = {
    entityType: 'school', key: 'reading_rooms', label: 'Reading rooms', type: 'integer',
    constraints: { minimum: 0, maximum: 12 }, required: true,
  };
  const studentDefinition = {
    entityType: 'student', key: 'club_choice', label: 'Club choice', type: 'choice',
    constraints: { options: ['reading', 'art'] },
  };
  let firstId, secondId, studentFieldId;

  await t.test('rejects protected keys, JavaScript and unapproved definition writes', async () => {
    for (const body of [
      { ...schoolDefinition, key: 'tenant_id' },
      { ...schoolDefinition, key: 'national_code' },
      { ...schoolDefinition, key: 'medical_notes' },
      { ...schoolDefinition, key: 'student_token' },
      { ...schoolDefinition, customScript: 'function() {}' },
      { ...schoolDefinition, constraints: { validator: 'x => x !== 0' } },
      { ...schoolDefinition, label: '<script>ignored</script>' },
      { ...schoolDefinition, label: 'javascript: text' },
    ]) {
      assert.equal((await publish('admin-a', body)).status, 422);
    }
    assert.equal((await publish('student-a', schoolDefinition)).status, 403);
    assert.deepEqual((await request('/field-definitions', 'admin-a')).data, []);
  });

  await t.test('publishes immutable schemas and preserves values and audit across revisions', async () => {
    const created = await publish('admin-a', schoolDefinition);
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('etag'), '"1"');
    assert.equal(created.data.schemaVersion, 1);
    firstId = created.data.id;
    const school = schoolPath(a.schoolId);
    assert.equal((await request(school, 'admin-a', { definitionId: firstId, value: 13, expectedVersion: 0 })).status, 422);
    const first = await request(school, 'admin-a', { definitionId: firstId, value: 6, expectedVersion: 0 });
    assert.equal(first.status, 201);
    assert.equal(first.data.valueVersion, 1);
    const writes = await Promise.all([
      request(school, 'admin-a', { definitionId: firstId, value: 8, expectedVersion: 1 }),
      request(school, 'admin-a', { definitionId: firstId, value: 9, expectedVersion: 1 }),
    ]);
    assert.deepEqual(writes.map(item => item.status).sort(), [201, 409]);
    const saved = writes.find(item => item.status === 201);
    assert.equal(saved.data.valueVersion, 2);
    const next = { ...schoolDefinition, constraints: { minimum: 5, maximum: 20 }, expectedVersion: 1 };
    const publishRace = await Promise.all([publish('admin-a', next), publish('admin-a', next)]);
    assert.deepEqual(publishRace.map(item => item.status).sort(), [201, 409]);
    const second = publishRace.find(item => item.status === 201);
    assert.equal(second.data.schemaVersion, 2);
    secondId = second.data.id;
    assert.notEqual(firstId, secondId);
    assert.equal((await request(school, 'admin-a', { definitionId: firstId, value: 6, expectedVersion: 2 })).status, 409);
    assert.equal((await request(school, 'admin-a', { definitionId: secondId, value: 4, expectedVersion: 0 })).status, 422);
    assert.equal((await request(school, 'admin-a', { definitionId: secondId, value: 14, expectedVersion: 0 })).status, 201);
    const definitionPage = await request('/field-definitions?key=reading_rooms&limit=1', 'admin-a');
    assert.equal(definitionPage.data.length, 1);
    assert(definitionPage.meta.nextCursor);
    const secondPage = await request('/field-definitions?key=reading_rooms&limit=1&cursor=' + definitionPage.meta.nextCursor, 'admin-a');
    assert.deepEqual(new Set([definitionPage.data[0].schemaVersion, secondPage.data[0].schemaVersion]), new Set([1, 2]));
    const history = await request(school, 'admin-a');
    assert.deepEqual(new Set(history.data.map(item => [item.schemaVersion, item.valueVersion, item.value].join(':'))),
      new Set(['1:1:6', '1:2:' + saved.data.value, '2:1:14']));
    const log = await admin.query(`
      SELECT v.created_by,v.request_id FROM people_fields.field_values v WHERE v.tenant_id = $1 AND v.id = $2
    `, [tenantA, first.data.id]);
    assert.deepEqual(log.rows, [{ created_by: managerA.actor, request_id: first.meta.requestId }]);
  });

  await t.test('student fields require explicit school permission and never mix the same child across schools', async () => {
    const created = await publish('admin-a', studentDefinition);
    assert.equal(created.status, 201);
    studentFieldId = created.data.id;
    assert.equal((await request(studentPath(a.schoolId), 'admin-a')).status, 404);
    assert.equal((await request('/field-values/student/' + studentId, 'student-a')).status, 422);
    assert.equal((await request(studentPath(aSecond.schoolId), 'student-a')).status, 404);
    const body = value => ({ definitionId: studentFieldId, value, expectedVersion: 0 });
    assert.equal((await request(studentPath(a.schoolId), 'student-a', body('unlisted'))).status, 422);
    assert.equal((await request(studentPath(a.schoolId), 'student-a', body('art'))).status, 201);
    assert.deepEqual((await request(studentPath(aSecond.schoolId), 'student-a-second')).data, []);
    assert.equal((await request(studentPath(aSecond.schoolId), 'student-a-second', body('reading'))).status, 201);
    const cleared = await request(studentPath(a.schoolId), 'student-a', { ...body(null), expectedVersion: 1 });
    assert.equal(cleared.status, 201);
    const firstSchool = (await request(studentPath(a.schoolId), 'student-a')).data;
    const secondSchool = (await request(studentPath(aSecond.schoolId), 'student-a-second')).data;
    assert.deepEqual(new Set(firstSchool.map(item => item.value)), new Set(['art', null]));
    assert.deepEqual(secondSchool.map(item => item.value), ['reading']);
    await admin.query(`
      UPDATE school_enrollment.enrollments SET status = 'inactive'
      WHERE tenant_id = $1 AND school_id = $2 AND student_person_id = $3
    `, [tenantA, a.schoolId, studentId]);
    assert.equal((await request(studentPath(a.schoolId), 'student-a')).status, 404);
    assert.equal((await request(studentPath(aSecond.schoolId), 'student-a-second')).status, 200);
  });

  await t.test('prevents foreign data and direct foreign-owner access while retaining a minimal event', async () => {
    assert.equal((await request(schoolPath(a.schoolId), 'admin-b')).status, 404);
    assert.equal((await request(schoolPath(b.schoolId), 'admin-b', { definitionId: secondId, value: 7, expectedVersion: 0 })).status, 404);
    assert.deepEqual((await request('/field-definitions?entityType=school', 'admin-b')).data, []);
    const tx = createTenantTransactions(fieldsPool);
    assert.equal((await tx.run(tenantB, db => db.query(
      'SELECT id FROM people_fields.field_values WHERE tenant_id = $1', [tenantA],
    ))).rowCount, 0);
    await assert.rejects(fieldsPool.query('SELECT student_person_id FROM school_enrollment.enrollments'), { code: '42501' });
    await assert.rejects(fieldsPool.query('SELECT id FROM tenancy_organization.tenants'), { code: '42501' });
    await assert.rejects(tx.run(tenantA, db => db.query(
      'DELETE FROM people_fields.field_values WHERE definition_id = $1', [firstId],
    )), { code: '42501' });
    const events = (await admin.query(`
      SELECT payload FROM platform_audit_jobs.outbox_events WHERE tenant_id = $1 AND event_type = 'fields.definition_published.v1'
    `, [tenantA])).rows.map(row => row.payload);
    assert.equal(events.length, 3);
    assert(events.every(event => Object.keys(event).sort().join(',') === 'definition_id,schema_version'));
    assert.deepEqual(new Set(events.map(event => event.definition_id)), new Set([firstId, secondId, studentFieldId]));
    await admin.query("UPDATE tenancy_organization.tenants SET status = 'suspended' WHERE id = $1", [tenantA]);
    assert.equal((await request('/field-definitions', 'admin-a')).status, 404);
    assert.equal((await request(schoolPath(a.schoolId), 'admin-a')).status, 404);
  });
});

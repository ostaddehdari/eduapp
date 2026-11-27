import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createGateway, GatewayError } from '../../apps/api-gateway/src/gateway.mjs';
import { createPeopleRoutes } from '../../apps/identity-service/src/people/gateway-routes.mjs';
import { createPeopleService } from '../../apps/identity-service/src/people/people-service.mjs';
import { createAccessRoutes, createProtectedSchoolRead } from '../../apps/identity-service/src/access/routes.mjs';
import { createAccessAuthorize, createAccessService, createPeopleFieldProjection } from '../../apps/identity-service/src/access/service.mjs';

const allow = (action, fields = []) => ({ action, effect: 'allow', fields });
const makeError = (code) => new GatewayError(code);

test('Gateway Access combines tenant and school scope, deny, relation, and field masks', async t => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const schoolA = randomUUID();
  const schoolB = randomUUID();
  const branchA = randomUUID();
  const branchB = randomUUID();
  const childA = randomUUID();
  const childB = randomUUID();
  const admin = randomUUID();
  const parent = randomUUID();
  const aMember = randomUUID();
  const bMember = randomUUID();
  const manager = randomUUID();
  const profileId = randomUUID();
  const target = {
    tenantId: tenantA, schoolId: schoolA, orgUnitId: branchA, studentId: childA, displayName: 'School A learner',
    gradeLevel: '5', attendanceStatus: 'present', medicalNote: 'fixture-hidden',
  };
  const resources = [target, { ...target, schoolId: schoolB, orgUnitId: branchB, studentId: childB }];
  const principals = {
    a: { actor: parent, tenantId: tenantA, scope: tenantA, membershipId: aMember, orgUnitId: branchA, sessionId: randomUUID() },
    b: { actor: parent, tenantId: tenantB, scope: tenantB, membershipId: bMember, orgUnitId: branchB, sessionId: randomUUID() },
    manager: { actor: admin, tenantId: tenantA, scope: tenantA, membershipId: manager, orgUnitId: null, sessionId: randomUUID() },
  };
  const membership = new Map(Object.values(principals).map(p => [p.membershipId, p]));
  const guardianRule = { ...allow('school.student.read', ['studentId', 'displayName']), relationship: 'verified_guardian' };
  const assignments = new Map([
    [aMember, [{ orgUnitId: branchA, rules: [guardianRule] }]],
    [bMember, [{ orgUnitId: branchB, rules: [guardianRule] }]],
    [manager, [{ orgUnitId: null, rules: [
      allow('access.role.read'), allow('access.role.write'), allow('access.role.assign'),
      allow('people.user.read', ['id']), allow('school.student.read', ['studentId']),
    ] }]],
  ]);
  const created = new Map();
  const repository = {
    async readBindings({ membershipId }) { return assignments.get(membershipId) ?? []; },
    async createRole({ tenantId, ...role }) {
      const row = { ...role, roleId: randomUUID(), version: 1, builtin: false };
      created.set(row.roleId, { tenantId, ...row });
      return row;
    },
    async getRole({ tenantId, roleId }) {
      const row = created.get(roleId);
      return row?.tenantId === tenantId ? row : null;
    },
    async updateRole({ tenantId, roleId, version, ...fields }) {
      const row = await this.getRole({ tenantId, roleId });
      if (!row) return { status: 'missing' };
      if (row.version !== version) return { status: 'stale' };
      const updated = { roleId, version: version + 1, builtin: false, ...fields };
      created.set(roleId, { tenantId, ...updated });
      return { status: 'updated', role: updated };
    },
    async assignRole(input) { return { ...input, roleBindingId: randomUUID() }; },
    async listRoles({ tenantId }) {
      return { data: [...created.values()].filter(role => role.tenantId === tenantId), nextPosition: null };
    },
  };
  async function resolveMembership({ identityId, tenantId, membershipId }) {
    const row = membership.get(membershipId);
    return row?.actor === identityId && row.tenantId === tenantId ? row : null;
  }
  let relation = true;
  let entitlement = true;
  let fresh = false;
  const access = createAccessService({
    repository, resolveMembership,
    verifyGuardian: async data => relation && data.tenantId === tenantA && data.orgUnitId === branchA &&
      data.studentId === childA && data.identityId === parent,
    hasEntitlement: async ({ tenantId, feature }) => entitlement && tenantId === tenantA && feature === 'school-core',
    verifyOrgUnit: async data => data.tenantId === tenantA && data.orgUnitId === branchA,
    requireRecentMfa: async ({ sessionId }) => fresh && sessionId === principals.manager.sessionId,
  });
  const readSchool = createProtectedSchoolRead({
    access, makeError,
    readOwnedStudent: async ids => resources.find(row =>
      row.tenantId === ids.tenantId && row.schoolId === ids.schoolId && row.studentId === ids.studentId),
  });
  const user = { id: profileId, displayName: 'Masked name', accidental: 'hidden' };
  const people = createPeopleService({
    access: { resolveMembership }, authorize: createAccessAuthorize(access),
    projectProfile: createPeopleFieldProjection(access), findActiveIdentity: async () => null,
    people: {
      async list({ tenantId }) { return { data: tenantId === tenantA ? [user] : [], nextPosition: null }; },
      async get({ tenantId }) { return tenantId === tenantA ? user : null; },
    },
  });
  const gateway = createGateway({
    authenticate: async header => principals[header?.slice(7)],
    routes: [
      ...createAccessRoutes({ access, makeError }),
      ...createPeopleRoutes({ service: people, GatewayError }),
      {
        id: 'listStudents', queryKeys: ['studentId'], budget: { max: 30, windowSeconds: 60 },
        authorize: async () => true,
        handle: async ({ identity, params, query }) => ({
          data: [await readSchool({
            identity, schoolId: params.schoolId, studentId: query.studentId, requiredEntitlement: 'school-core',
          })], nextPosition: null,
        }),
      },
    ],
  });
  const server = createServer(gateway).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  function send(path, principal, { method = 'GET', body, headers = {} } = {}) {
    return fetch(`http://127.0.0.1:${server.address().port}/v1${path}`, {
      method, headers: {
        ...headers, authorization: 'Bearer ' + principal, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  const read = (school, child, as, headers) => send('/schools/' + school + '/students?studentId=' + child, as, { headers });
  const granted = await read(schoolA, childA, 'a');
  assert.equal(granted.status, 200);
  assert.deepEqual((await granted.json()).data, [{ studentId: childA, displayName: target.displayName }]);
  assert.equal((await read(schoolA, childA, 'b', { 'X-Tenant-Id': tenantA })).status, 404);
  assert.equal((await read(schoolB, childB, 'a')).status, 404);
  relation = false;
  assert.equal((await read(schoolA, childA, 'a')).status, 404);
  relation = true;
  entitlement = false;
  assert.equal((await read(schoolA, childA, 'a')).status, 404);
  entitlement = true;
  assignments.get(aMember).push({ orgUnitId: branchA, rules: [{ action: 'school.student.read', effect: 'deny' }] });
  assert.equal((await read(schoolA, childA, 'a')).status, 404);

  const single = await send('/users/' + profileId, 'manager');
  assert.equal(single.status, 200);
  assert.deepEqual((await single.json()).data, { id: profileId });
  const list = await send('/users', 'manager');
  assert.deepEqual((await list.json()).data, [{ id: profileId }]);
  assert.equal((await send('/users/' + profileId, 'b')).status, 404);

  const custom = { name: 'School assistant', rules: [allow('school.student.read', ['studentId'])] };
  assert.equal((await send('/roles', 'manager', { method: 'POST', body: custom })).status, 403);
  fresh = true;
  assert.equal((await send('/roles', 'manager', {
    method: 'POST', body: { ...custom, rules: [allow('access.role.write')] },
  })).status, 422);
  assert.equal((await send('/roles', 'manager', {
    method: 'POST', body: { ...custom, rules: [allow('people.user.read', ['displayName'])] },
  })).status, 403);
  const createdRole = await send('/roles', 'manager', { method: 'POST', body: custom });
  assert.equal(createdRole.status, 201);
  const role = (await createdRole.json()).data;
  assert.equal((await send('/roles', 'a')).status, 403);
  assert.equal((await send('/roles', 'manager')).status, 200);
  const capability = await send('/me/capabilities', 'manager');
  assert((await capability.json()).data.capabilities.some(entry => entry.action === 'access.role.write'));
  const updated = await send('/roles/' + role.roleId, 'manager', {
    method: 'PATCH', body: custom, headers: { 'If-Match': '"1"' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.headers.get('etag'), '"2"');
  assert.equal((await send('/roles/' + role.roleId, 'manager', {
    method: 'PATCH', body: custom, headers: { 'If-Match': '"1"' },
  })).status, 412);
  assert.equal((await send('/role-assignments', 'manager', {
    method: 'POST', body: { roleId: role.roleId, membershipId: aMember, orgUnitId: branchA },
  })).status, 201);
  assert.equal((await send('/role-assignments', 'manager', {
    method: 'POST', body: { roleId: role.roleId, membershipId: aMember, orgUnitId: branchB },
  })).status, 404);
  membership.delete(aMember);
  assert.equal((await read(schoolA, childA, 'a')).status, 404);
});

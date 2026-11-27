import { AccessError, hasAccessContext, maskFields } from './policy.mjs';

export function createAccessRoutes({ access, makeError, budget = { max: 30, windowSeconds: 60 } }) {
  function route(id, handle) {
    return {
      id,
      budget,
      authorize: ({ identity }) => hasAccessContext(identity),
      async handle(input) {
        try {
          return await handle(input);
        } catch (error) {
          if (error instanceof AccessError) throw makeError(error.message);
          throw error;
        }
      },
    };
  }

  return [
    route('getMyCapabilities', async ({ identity }) => ({ data: await access.capabilities(identity) })),
    route('listRoles', ({ identity, page, requestId }) => access.listRoles(identity, page, requestId)),
    route('createRole', async ({ identity, body, requestId }) => ({
      status: 201, data: await access.createRole(identity, body, requestId),
    })),
    route('updateRole', async ({ identity, params, ifMatch, body, requestId }) => {
      const data = await access.updateRole(identity, params.roleId, ifMatch, body, requestId);
      return { data, etag: `"${data.version}"` };
    }),
    route('assignRole', async ({ identity, body, requestId }) => ({
      status: 201, data: await access.assignRole(identity, body, requestId),
    })),
  ];
}

export function createProtectedSchoolRead({ access, readOwnedStudent, makeError }) {
  return async ({ identity, schoolId, studentId, requiredEntitlement }) => {
    if (!hasAccessContext(identity)) throw makeError('NOT_FOUND');
    const resource = await readOwnedStudent({ tenantId: identity.tenantId, schoolId, studentId });
    if (!resource || resource.tenantId !== identity.tenantId || resource.schoolId !== schoolId ||
      resource.studentId !== studentId) throw makeError('NOT_FOUND');
    const decision = await access.decide(identity, {
      action: 'school.student.read', tenantId: resource.tenantId, orgUnitId: resource.orgUnitId,
      subjectId: resource.studentId, requiredEntitlement,
    });
    if (!decision.allowed) throw makeError('NOT_FOUND');
    return maskFields(resource, decision);
  };
}

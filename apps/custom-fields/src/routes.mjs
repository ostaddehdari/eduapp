import { CustomFieldsError } from './schema.mjs';

export function createCustomFieldsRoutes({ fields, GatewayError }) {
  const budget = { max: 30, windowSeconds: 60 };
  const authorize = ({ identity }) => Boolean(identity?.tenantId && identity.scope === identity.tenantId && identity.membershipId);
  function route(id, handle, queryKeys = []) {
    return {
      id, budget, authorize, queryKeys,
      async handle(input) {
        try {
          return await handle(input);
        } catch (error) {
          if (error instanceof CustomFieldsError) throw new GatewayError(error.message);
          throw error;
        }
      },
    };
  }
  const resourceInput = ({ identity, params, query, page, body, requestId }) => ({
    identity, entityType: params.entityType, entityId: params.entityId, schoolId: query.schoolId, page, body, requestId,
  });
  return [
    route('listFieldDefinitions', ({ identity, query, page }) =>
      fields.listDefinitions({ identity, entityType: query.entityType, key: query.key, page }), ['entityType', 'key']),
    route('createFieldDefinition', async input => {
      const data = await fields.createDefinition(input);
      return { status: 201, data, etag: '"' + data.schemaVersion + '"' };
    }),
    route('listFieldValues', input => fields.listValues(resourceInput(input)), ['schoolId']),
    route('createFieldValue', async input => {
      const data = await fields.createValue(resourceInput(input));
      return { status: 201, data, etag: '"' + data.valueVersion + '"' };
    }, ['schoolId']),
  ];
}

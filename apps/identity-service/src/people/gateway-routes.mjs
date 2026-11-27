import { hasInvitationPrincipal, hasPeopleScope, PeopleError } from './people-service.mjs';

export function createPeopleRoutes({
  service, GatewayError, scopedInvitations = false, budget = { max: 30, windowSeconds: 60 },
}) {
  function route(id, method, status, mapInput, paged = false, authorize = hasPeopleScope) {
    return {
      id,
      budget,
      authorize: ({ identity }) => authorize(identity),
      async handle(input) {
        try {
          const result = await service[method](mapInput(input));
          return paged ? { status, ...result } : { status, data: result };
        } catch (error) {
          if (error instanceof PeopleError) throw new GatewayError(error.message);
          throw error;
        }
      },
    };
  }

  const write = ({ identity, body, requestId }) => ({ identity, body, requestId });
  const redeem = ({ identity, body }) => {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => key !== 'tenantId' && key !== 'token')) {
      throw new PeopleError('VALIDATION_FAILED');
    }
    return { principal: identity, tenantId: body.tenantId, token: body.token };
  };
  return [
    route('listUsers', 'listUsers', 200, ({ identity, page, requestId }) => ({ identity, page, requestId }), true),
    route('getUser', 'getUser', 200, ({ identity, params, requestId }) => ({ identity, profileId: params.userId, requestId })),
    route('createUser', 'createUser', 201, write),
    route('createMembership', 'createMembership', 201, write),
    route('createInvitation', 'createInvitation', 202, write),
    ...(scopedInvitations ? [
      route('acceptInvitation', 'acceptInvitation', 200, redeem, false, hasInvitationPrincipal),
    ] : []),
  ];
}

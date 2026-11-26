import { hasPeopleScope, PeopleError } from './people-service.mjs';

export function createPeopleRoutes({ service, GatewayError, budget = { max: 30, windowSeconds: 60 } }) {
  function route(id, method, status, mapInput, paged = false) {
    return {
      id,
      budget,
      authorize: ({ identity }) => hasPeopleScope(identity),
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

  const write = ({ identity, body }) => ({ identity, body });
  return [
    route('listUsers', 'listUsers', 200, ({ identity, page }) => ({ identity, page }), true),
    route('getUser', 'getUser', 200, ({ identity, params }) => ({ identity, profileId: params.userId })),
    route('createUser', 'createUser', 201, write),
    route('createMembership', 'createMembership', 201, write),
    route('createInvitation', 'createInvitation', 202, write),
  ];
}

import { AuthError } from './service.mjs';

const publicBudget = { max: 35, windowSeconds: 60 };
const sessionBudget = { max: 60, windowSeconds: 60 };

function readBearer(header) {
  return typeof header === 'string' ? /^Bearer ([A-Za-z0-9_.-]{1,1024})$/i.exec(header)?.[1] : undefined;
}

export function createAuthRoutes({ auth, GatewayError }) {
  const handle = (action) => async (input) => {
    try {
      return await action(input);
    } catch (error) {
      if (error instanceof AuthError) throw new GatewayError(error.code, { retryAfter: error.retryAfter });
      throw error;
    }
  };
  return [
    {
      id: 'login', budget: publicBudget,
      handle: handle(async ({ body, requestId }) => ({ data: await auth.login(body ?? {}, { requestId }) })),
    },
    {
      id: 'requestOtp', budget: publicBudget,
      handle: handle(async ({ body }) => ({ status: 202, data: await auth.requestOtp(body ?? {}) })),
    },
    {
      id: 'verifyOtp', budget: publicBudget,
      handle: handle(async ({ body, requestId }) => ({ data: await auth.verifyOtp(body ?? {}, { requestId }) })),
    },
    {
      id: 'refreshSession', budget: publicBudget, forwardAuthorization: true,
      handle: handle(async ({ body, authorization }) => ({
        data: await auth.refresh({ ...body, refreshToken: readBearer(authorization) }),
      })),
    },
    {
      id: 'logout', budget: sessionBudget,
      authorize: ({ identity }) => Boolean(identity?.identityId && identity.sessionId),
      handle: handle(async ({ identity }) => {
        await auth.logout(identity);
        return { status: 204 };
      }),
    },
    {
      id: 'listMySessions', budget: sessionBudget,
      authorize: ({ identity }) => Boolean(identity?.identityId && identity.sessionId),
      handle: handle(({ identity, page }) => auth.listSessions(identity, page)),
    },
  ];
}

export function createAuthGatewayOptions(auth, { GatewayError }) {
  return {
    routes: createAuthRoutes({ auth, GatewayError }),
    async authenticate(header) {
      const identity = await auth.authenticate(readBearer(header));
      return identity && { ...identity, actor: identity.identityId, scope: identity.tenantId ?? 'identity-bootstrap' };
    },
  };
}

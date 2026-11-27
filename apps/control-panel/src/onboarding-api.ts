import { readOnboardingState, type Advance } from './onboarding-model';

export type Session = { tenantId: string; accessToken: string };
export type LoginInput = { login: string; password: string; tenantId: string };

export class GatewayRequestError extends Error {
  constructor(readonly status: number) {
    super('GATEWAY_REQUEST_FAILED');
  }
}

export function createOnboardingClient(config: string, transport: typeof fetch = fetch) {
  const base = config.replace(/\/+$/, '');
  if (base !== base.trim() || !/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(base)) {
    throw new GatewayRequestError(503);
  }
  const api = base + '/v1';

  async function call(path: string, accessToken?: string, body?: object) {
    const response = await transport(api + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    if (!response.ok) throw new GatewayRequestError(response.status);
    if (response.status === 204) return undefined;
    return (await response.json() as { data?: unknown }).data;
  }

  function checkedState(value: unknown) {
    const state = readOnboardingState(value);
    if (!state) throw new GatewayRequestError(503);
    return state;
  }

  return {
    async login(input: LoginInput): Promise<Session> {
      const result = await call('/auth/login', undefined, input) as Partial<Session> | undefined;
      if (!result || typeof result.accessToken !== 'string' || !result.accessToken || result.tenantId !== input.tenantId) {
        throw new GatewayRequestError(403);
      }
      return { tenantId: result.tenantId, accessToken: result.accessToken };
    },
    async read(session: Session) {
      return checkedState(await call('/onboarding', session.accessToken));
    },
    async advance(session: Session, expectedVersion: number, payload: Advance) {
      return checkedState(await call('/onboarding/advance', session.accessToken, { expectedVersion, ...payload }));
    },
    async verifyInvitation(session: Session, code: string) {
      await call('/auth/mfa/step-up', session.accessToken, { code });
    },
    async logout(session: Session) {
      await call('/auth/logout', session.accessToken, {});
    },
  };
}

export type OnboardingClient = ReturnType<typeof createOnboardingClient>;

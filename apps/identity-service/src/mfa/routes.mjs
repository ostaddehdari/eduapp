import { AuthError } from '../auth/service.mjs';

export function createMfaRoutes({ mfa, GatewayError }) {
  return [
    ['beginMfaEnrollment', mfa.beginEnrollment],
    ['confirmMfaEnrollment', mfa.confirmEnrollment],
    ['verifyMfaStepUp', mfa.stepUp],
    ['requestMfaRecovery', mfa.requestRecovery],
    ['confirmMfaRecovery', mfa.confirmRecovery],
  ].map(([id, invoke]) => ({
    id,
    budget: { max: 15, windowSeconds: 60 },
    authorize: ({ identity }) => Boolean(identity?.identityId && identity.sessionId),
    async handle({ identity, body }) {
      try {
        return { data: await invoke(identity, body ?? {}) };
      } catch (error) {
        if (error instanceof AuthError) throw new GatewayError(error.code, { retryAfter: error.retryAfter });
        throw error;
      }
    },
  }));
}

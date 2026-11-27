import { createAuthService } from '../../identity-service/src/auth/service.mjs';
import { createAuthGatewayOptions } from '../../identity-service/src/auth/routes.mjs';
import { createPostgresAccessRepository } from '../../identity-service/src/access/repository.mjs';
import { createAccessService, createAccessAuthorize, createPeopleFieldProjection } from '../../identity-service/src/access/service.mjs';
import { createAccessRoutes } from '../../identity-service/src/access/routes.mjs';
import { createMfaService } from '../../identity-service/src/mfa/service.mjs';
import { createMfaRoutes } from '../../identity-service/src/mfa/routes.mjs';
import { createAccessRepository } from '../../identity-service/src/people/access-repository.mjs';
import { createPeopleRepository } from '../../identity-service/src/people/people-repository.mjs';
import { createPeopleService } from '../../identity-service/src/people/people-service.mjs';
import { createPeopleRoutes } from '../../identity-service/src/people/gateway-routes.mjs';
import { createTenantTransactions } from '../../../packages/data/src/tenant-transactions.mjs';
import { GatewayError } from './gateway.mjs';

export function createIdentityGatewayOptions({
  iamPool, peoplePool, accessPool, accessSigningKey, otpPepper, deliverOtp, mfaEncryptionKey,
  authorize, accessPolicy, verifyOrgUnit, deliverInvitation, now,
}) {
  const pools = [iamPool, peoplePool, accessPool];
  if (pools.some(pool => typeof pool?.connect !== 'function') || new Set(pools).size !== pools.length) {
    throw new TypeError('Identity requires distinct IAM, People and Access pools');
  }
  if ((!accessPolicy && typeof authorize !== 'function') || (accessPolicy && authorize !== undefined)) {
    throw new TypeError('Identity requires exactly one People/Access authorization policy');
  }
  if (Buffer.isBuffer(mfaEncryptionKey) &&
    [accessSigningKey, otpPepper].some(key => Buffer.isBuffer(key) && key.equals(mfaEncryptionKey))) {
    throw new TypeError('Use a distinct MFA encryption key');
  }

  const transactions = createTenantTransactions(accessPool);
  const access = createAccessRepository({ transactions });
  const people = createPeopleRepository({ transactions: createTenantTransactions(peoplePool) });
  const resolveMembership = input => access.resolveMembership(input);
  const auth = createAuthService({
    pool: iamPool, resolveMembership, deliverOtp, accessSigningKey, otpPepper, now,
  });
  const mfa = mfaEncryptionKey === undefined ? null : createMfaService({
    pool: iamPool, encryptionKey: mfaEncryptionKey, otpPepper, now,
  });
  const requireRecentMfa = identity => mfa?.isFresh(identity) ?? false;
  const permissionService = accessPolicy ? createAccessService({
    repository: createPostgresAccessRepository({ transactions }),
    resolveMembership, verifyGuardian: accessPolicy.verifyGuardian,
    hasEntitlement: accessPolicy.hasEntitlement, verifyOrgUnit, requireRecentMfa, now,
  }) : null;
  const service = createPeopleService({
    people, access,
    authorize: permissionService ? createAccessAuthorize(permissionService) : authorize,
    projectProfile: permissionService ? createPeopleFieldProjection(permissionService) : undefined,
    findActiveIdentity: input => auth.findActiveIdentity(input),
    verifyOrgUnit, deliverInvitation, requireRecentMfa,
  });
  const authOptions = createAuthGatewayOptions(auth, { GatewayError });
  return {
    authenticate: authOptions.authenticate,
    routes: [
      ...authOptions.routes,
      ...createPeopleRoutes({ service, GatewayError }),
      ...(permissionService ? createAccessRoutes({ access: permissionService, makeError: code => new GatewayError(code) }) : []),
      ...(mfa ? createMfaRoutes({ mfa, GatewayError }) : []),
    ],
  };
}

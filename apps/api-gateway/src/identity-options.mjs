import { createAuthService } from '../../identity-service/src/auth/service.mjs';
import { createAuthGatewayOptions } from '../../identity-service/src/auth/routes.mjs';
import { createAccessRepository } from '../../identity-service/src/people/access-repository.mjs';
import { createPeopleRepository } from '../../identity-service/src/people/people-repository.mjs';
import { createPeopleService } from '../../identity-service/src/people/people-service.mjs';
import { createPeopleRoutes } from '../../identity-service/src/people/gateway-routes.mjs';
import { createTenantTransactions } from '../../../packages/data/src/tenant-transactions.mjs';
import { GatewayError } from './gateway.mjs';

export function createIdentityGatewayOptions({
  iamPool, peoplePool, accessPool, accessSigningKey, otpPepper, deliverOtp,
  authorize, verifyOrgUnit, deliverInvitation, now,
}) {
  const pools = [iamPool, peoplePool, accessPool];
  if (pools.some(pool => typeof pool?.connect !== 'function') || new Set(pools).size !== pools.length) {
    throw new TypeError('Identity requires distinct IAM, People and Access pools');
  }
  if (typeof authorize !== 'function') throw new TypeError('Identity requires a People/Access authorization policy');

  const access = createAccessRepository({ transactions: createTenantTransactions(accessPool) });
  const people = createPeopleRepository({ transactions: createTenantTransactions(peoplePool) });
  const auth = createAuthService({
    pool: iamPool,
    resolveMembership: input => access.resolveMembership(input),
    deliverOtp, accessSigningKey, otpPepper, now,
  });
  const service = createPeopleService({
    people, access, authorize, findActiveIdentity: input => auth.findActiveIdentity(input),
    verifyOrgUnit, deliverInvitation,
  });
  const authOptions = createAuthGatewayOptions(auth, { GatewayError });
  return {
    authenticate: authOptions.authenticate,
    routes: [...authOptions.routes, ...createPeopleRoutes({ service, GatewayError })],
  };
}

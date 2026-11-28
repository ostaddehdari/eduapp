import { createPlanCatalog } from './catalog.mjs';
import { DelegationError } from './delegations.mjs';

export function createDelegationGatewayRoutes({ service, GatewayError }) {
  if (typeof service?.request !== 'function' || typeof service?.decide !== 'function' ||
    typeof service?.canManage !== 'function' || typeof GatewayError !== 'function') {
    throw new TypeError('A delegated management service and Gateway error type are required');
  }
  const identity = principal => ({ tenantId: principal.tenantId, scope: principal.scope, actorId: principal.actor });
  const run = async work => {
    try { return await work(); } catch (error) {
      if (error instanceof DelegationError) {
        const code = ['INVALID_REQUEST', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT'].includes(error.message)
          ? error.message : error.message === 'SEATS_EXHAUSTED' ? 'CONFLICT' : 'SERVICE_UNAVAILABLE';
        throw new GatewayError(code);
      }
      throw error;
    }
  };
  const budget = { max: 20, windowSeconds: 60 };
  const authorize = ({ identity: principal }) => principal?.tenantId === principal?.scope;
  return [
    { id: 'requestManagementDelegation', budget, authorize,
      handle: ({ identity: principal, body }) => run(async () => ({ status: 201, data: await service.request({
        subscriptionId: body?.subscriptionId, delegateIdentityId: body?.delegateIdentityId,
        scopeOrgId: body?.scopeOrgId, expiresAt: body?.expiresAt, requestKey: body?.requestKey,
        identity: identity(principal),
      }) })) },
    { id: 'decideManagementDelegation', budget, authorize,
      handle: ({ identity: principal, params, body }) => run(async () => ({ data: await service.decide({
        identity: identity(principal), delegationId: params.delegationId, action: body?.action,
      }) })) },
    { id: 'checkManagementDelegation', budget, authorize, queryKeys: ['scopeOrgId'],
      handle: ({ identity: principal, query }) => run(async () => ({ data: {
        allowed: await service.canManage({ identity: identity(principal), scopeOrgId: query.scopeOrgId }),
      } })) },
  ];
}

export function createCommerceGatewayOptions({ pool, authorizePublish, now, delegation }, GatewayError) {
  const catalog = createPlanCatalog({ pool, authorizePublish, now });
  return {
    catalog,
    routes: [{
      id: 'listPlans',
      budget: { max: 40, windowSeconds: 60 },
      handle: ({ page }) => catalog.list({ page }),
    }, ...(delegation ? createDelegationGatewayRoutes({ service: delegation.service, GatewayError }) : [])],
  };
}

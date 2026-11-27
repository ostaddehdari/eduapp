import { createTenantTransactions } from '../../../packages/data/src/tenant-transactions.mjs';
import { createTenantRegistry, createTenantRegistryRoutes } from '../../tenant-org-service/src/registry.mjs';
import { createOrganizationTree, OrganizationError } from '../../tenant-org-service/src/tree.mjs';
import { GatewayError } from './gateway.mjs';

const budget = Object.freeze({ max: 30, windowSeconds: 60 });

export function createTenancyGatewayOptions({
  pool, authorize, authorizeProvisioning, authorizeStatusChange, now,
}) {
  if (typeof pool?.connect !== 'function' || typeof authorize !== 'function') {
    throw new TypeError('Tenancy requires an owner pool and authorization policy');
  }
  const transactions = createTenantTransactions(pool);
  const registry = createTenantRegistry({
    transactions, authorizeProvisioning, authorizeStatusChange, now,
    authorizeTenant: ({ identity, tenantId }) => authorize({ identity, tenantId, action: 'tenancy.tenant.read' }),
  });
  const tree = createOrganizationTree({ transactions, authorize });

  function organizationRoute(id, handle) {
    return {
      id, budget,
      authorize: ({ identity }) => identity.scope === identity.tenantId,
      async handle(input) {
        try {
          return await handle(input);
        } catch (error) {
          if (error instanceof OrganizationError) throw new GatewayError(error.message);
          throw error;
        }
      },
    };
  }
  const list = ({ identity, page }) => tree.list({ identity, page });
  return {
    isActive: registry.isActive,
    routes: [
      ...createTenantRegistryRoutes({ registry, GatewayError }),
      organizationRoute('listOrgUnits', list),
      organizationRoute('getOrgTree', list),
      organizationRoute('createOrgUnit', async ({ identity, body, requestId }) => {
        const data = await tree.create({ identity, body, requestId });
        return { status: 201, data, etag: '"' + data.version + '"' };
      }),
      organizationRoute('moveOrgUnit', async ({ identity, params, body, ifMatch, requestId }) => {
        const data = await tree.move({ identity, orgUnitId: params.orgUnitId, body, ifMatch, requestId });
        return { data, etag: '"' + data.version + '"' };
      }),
    ],
  };
}

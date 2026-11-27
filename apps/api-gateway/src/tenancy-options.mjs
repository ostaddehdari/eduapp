import { createTenantTransactions } from '../../../packages/data/src/tenant-transactions.mjs';
import { createTenantRegistry, createTenantRegistryRoutes } from '../../tenant-org-service/src/registry.mjs';
import { createOrganizationTree, OrganizationError } from '../../tenant-org-service/src/tree.mjs';
import { createOnboarding, OnboardingError } from '../../tenant-org-service/src/onboarding.mjs';
import {
  createManagementReadPorts, createManagementRoutes, createManagementService,
} from '../../tenant-org-service/src/management.mjs';
import { createCustomFields } from '../../custom-fields/src/service.mjs';
import { createCustomFieldsRoutes } from '../../custom-fields/src/routes.mjs';
import { PeopleError } from '../../identity-service/src/people/people-service.mjs';
import { GatewayError } from './gateway.mjs';

const budget = Object.freeze({ max: 30, windowSeconds: 60 });

export function createTenancyGatewayOptions({
  pool, authorize, authorizeProvisioning, authorizeStatusChange, onboarding, management, fieldsPool, now,
}) {
  if (typeof pool?.connect !== 'function' || typeof authorize !== 'function') {
    throw new TypeError('Tenancy requires an owner pool and authorization policy');
  }
  const transactions = createTenantTransactions(pool);
  const registry = createTenantRegistry({
    transactions, authorizeProvisioning,
    authorizeStatusChange: management ? async () => false : authorizeStatusChange,
    now,
    authorizeTenant: ({ identity, tenantId }) => authorize({ identity, tenantId, action: 'tenancy.tenant.read' }),
  });
  const tree = createOrganizationTree({ transactions, authorize });
  const wizard = onboarding && createOnboarding({
    transactions, tree, authorize, inviteManager: onboarding.inviteManager,
    schoolTransactions: createTenantTransactions(onboarding.schoolPool),
    sitesTransactions: createTenantTransactions(onboarding.sitesPool),
  });
  const fields = fieldsPool && createCustomFields({ transactions: createTenantTransactions(fieldsPool), authorize });
  const managementService = management && createManagementService({
    transactions, authorize, resolvePlatformScopes: management.resolvePlatformScopes,
    requireRecentMfa: management.requireRecentMfa,
    ...createManagementReadPorts({
      billingTransactions: createTenantTransactions(management.billingPool),
      accessTransactions: createTenantTransactions(management.accessPool),
    }),
  });

  function organizationRoute(id, handle) {
    return {
      id, budget,
      authorize: ({ identity }) => identity.scope === identity.tenantId,
      async handle(input) {
        try {
          return await handle(input);
        } catch (error) {
          if (error instanceof OrganizationError || error instanceof OnboardingError || error instanceof PeopleError) {
            throw new GatewayError(error.message);
          }
          throw error;
        }
      },
    };
  }
  const list = ({ identity, page }) => tree.list({ identity, page });
  return {
    isActive: registry.isActive,
    verifyOrgUnit: tree.verifyOrgUnit,
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
      ...(wizard ? [
        organizationRoute('readOnboarding', async input => ({ data: await wizard.read(input) })),
        organizationRoute('advanceOnboarding', async input => ({ data: await wizard.advance(input) })),
      ] : []),
      ...(fields ? createCustomFieldsRoutes({ fields, GatewayError }) : []),
      ...(managementService ? createManagementRoutes({ service: managementService, GatewayError }) : []),
    ],
  };
}

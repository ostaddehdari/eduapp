import { createPlanCatalog } from './catalog.mjs';

export function createCommerceGatewayOptions({ pool, authorizePublish, now }) {
  const catalog = createPlanCatalog({ pool, authorizePublish, now });
  return {
    catalog,
    routes: [{
      id: 'listPlans',
      budget: { max: 40, windowSeconds: 60 },
      handle: ({ page }) => catalog.list({ page }),
    }],
  };
}

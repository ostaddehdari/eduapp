import { createServer } from 'node:http';
import { createGatewayMonitor } from '../../../infra/monitoring/gateway-monitor.mjs';
import { createApiReadinessProbe, createMetricsServer } from '../../../infra/monitoring/runtime.mjs';
import { createGateway, GatewayError } from './gateway.mjs';
import { createIdentityGatewayOptions } from './identity-options.mjs';
import { createTenancyGatewayOptions } from './tenancy-options.mjs';
import { createCommerceGatewayOptions } from '../../commerce-service/src/routes.mjs';
import { createPaymentWebhookHandler } from '../../commerce-service/src/webhook-http.mjs';

export function createGatewayRuntime({ monitoring, gatewayOptions = {}, identity, tenancy, commerce, emit } = {}) {
  if (identity && gatewayOptions.authenticate) {
    throw new TypeError('Use one Gateway authentication provider');
  }
  if (tenancy && identity && [identity.iamPool, identity.accessPool, identity.peoplePool].includes(tenancy.pool)) {
    throw new TypeError('Tenancy requires a separate database role');
  }
  if (tenancy && !tenancy.authorize && !identity?.accessPolicy) {
    throw new TypeError('Tenancy requires Access policy or explicit owner authorization');
  }
  if (tenancy?.onboarding || tenancy?.management || tenancy?.fieldsPool) {
    const pools = [identity?.iamPool, identity?.accessPool, identity?.peoplePool, tenancy.pool];
    if (tenancy.onboarding) pools.push(tenancy.onboarding.schoolPool, tenancy.onboarding.sitesPool);
    if (tenancy.management) pools.push(tenancy.management.billingPool);
    if (tenancy.fieldsPool) pools.push(tenancy.fieldsPool);
    if (pools.some(pool => typeof pool?.connect !== 'function') || new Set(pools).size !== pools.length) {
      throw new TypeError('Configured owners require distinct database pools');
    }
  }
  if (commerce && (typeof commerce.pool?.connect !== 'function' || typeof commerce.pool?.query !== 'function' ||
    [identity?.iamPool, identity?.accessPool, identity?.peoplePool, tenancy?.pool,
      tenancy?.management?.billingPool].includes(commerce.pool))) {
    throw new TypeError('Commerce requires an independent billing owner pool');
  }
  const commerceOptions = commerce ? createCommerceGatewayOptions(commerce, GatewayError) : {};
  const tenancyOptions = tenancy ? createTenancyGatewayOptions({
    ...tenancy,
    authorize: tenancy.authorize ?? (({ identity: principal, tenantId, action, orgUnitId = null, subjectId }) =>
      identityOptions.authorizeTenancy(principal, { tenantId, action, orgUnitId, subjectId })),
    onboarding: tenancy.onboarding && {
      ...tenancy.onboarding,
      inviteManager: input => identityOptions.inviteManager(input),
    },
    management: tenancy.management && {
      ...tenancy.management,
      accessPool: identity?.accessPool,
      requireRecentMfa: principal => identityOptions.requireRecentMfa(principal),
    },
  }) : {};
  const identityOptions = identity ? createIdentityGatewayOptions({
    ...identity, tenantActive: tenancyOptions.isActive,
    verifyOrgUnit: tenancyOptions.verifyOrgUnit ?? identity.verifyOrgUnit,
    scopedInvitations: Boolean(tenancy),
    registryOwnerFields: Boolean(tenancy?.fieldsPool),
    allowPlatformStepUp: tenancy?.management && (async principal => {
      const scopes = await tenancy.management.resolvePlatformScopes({
        identity: { ...principal, actor: principal.identityId, scope: 'identity-bootstrap' },
      });
      return Array.isArray(scopes) && scopes.some(scope =>
        scope?.requestStatusChange === true || scope?.decideStatusChange === true);
    }),
  }) : {};
  const monitor = monitoring && createGatewayMonitor({ mode: monitoring.mode, emit });
  const ready = monitoring?.apiPort ? createApiReadinessProbe(monitoring.apiPort) : gatewayOptions.ready;
  const gatewayHandler = createGateway({
      ...gatewayOptions, ...identityOptions, ready, monitor,
      routes: [...(gatewayOptions.routes ?? []), ...(identityOptions.routes ?? []),
        ...(tenancyOptions.routes ?? []), ...(commerceOptions.routes ?? [])],
    });
  const webhook = commerce?.payment && createPaymentWebhookHandler(commerce.payment);
  const gateway = createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000 },
    (req, res) => req.url?.startsWith('/v1/webhooks/payments/') && webhook
      ? webhook(req, res) : gatewayHandler(req, res),
  );
  return { gateway, metrics: monitor ? createMetricsServer(monitor) : null };
}

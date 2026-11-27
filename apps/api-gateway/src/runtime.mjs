import { createServer } from 'node:http';
import { createGatewayMonitor } from '../../../infra/monitoring/gateway-monitor.mjs';
import { createApiReadinessProbe, createMetricsServer } from '../../../infra/monitoring/runtime.mjs';
import { createGateway } from './gateway.mjs';
import { createIdentityGatewayOptions } from './identity-options.mjs';
import { createTenancyGatewayOptions } from './tenancy-options.mjs';

export function createGatewayRuntime({ monitoring, gatewayOptions = {}, identity, tenancy, emit } = {}) {
  if (identity && gatewayOptions.authenticate) {
    throw new TypeError('Use one Gateway authentication provider');
  }
  if (tenancy && identity && [identity.iamPool, identity.accessPool, identity.peoplePool].includes(tenancy.pool)) {
    throw new TypeError('Tenancy requires a separate database role');
  }
  if (tenancy && !tenancy.authorize && !identity?.accessPolicy) {
    throw new TypeError('Tenancy requires Access policy or explicit owner authorization');
  }
  const tenancyOptions = tenancy ? createTenancyGatewayOptions({
    ...tenancy,
    authorize: tenancy.authorize ?? (({ identity: principal, tenantId, action }) =>
      identityOptions.authorizeTenancy(principal, { tenantId, action, orgUnitId: null })),
  }) : {};
  const identityOptions = identity ? createIdentityGatewayOptions({
    ...identity, tenantActive: tenancyOptions.isActive,
  }) : {};
  const monitor = monitoring && createGatewayMonitor({ mode: monitoring.mode, emit });
  const ready = monitoring?.apiPort ? createApiReadinessProbe(monitoring.apiPort) : gatewayOptions.ready;
  const gateway = createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000 },
    createGateway({
      ...gatewayOptions, ...identityOptions, ready, monitor,
      routes: [...(gatewayOptions.routes ?? []), ...(identityOptions.routes ?? []), ...(tenancyOptions.routes ?? [])],
    }),
  );
  return { gateway, metrics: monitor ? createMetricsServer(monitor) : null };
}

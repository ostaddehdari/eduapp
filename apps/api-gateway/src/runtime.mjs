import { createServer } from 'node:http';
import { createGatewayMonitor } from '../../../infra/monitoring/gateway-monitor.mjs';
import { createApiReadinessProbe, createMetricsServer } from '../../../infra/monitoring/runtime.mjs';
import { createGateway } from './gateway.mjs';
import { createIdentityGatewayOptions } from './identity-options.mjs';

export function createGatewayRuntime({ monitoring, gatewayOptions = {}, identity, emit } = {}) {
  if (identity && gatewayOptions.authenticate) {
    throw new TypeError('Use one Gateway authentication provider');
  }
  const identityOptions = identity ? createIdentityGatewayOptions(identity) : {};
  const monitor = monitoring && createGatewayMonitor({ mode: monitoring.mode, emit });
  const ready = monitoring?.apiPort ? createApiReadinessProbe(monitoring.apiPort) : gatewayOptions.ready;
  const gateway = createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000 },
    createGateway({
      ...gatewayOptions, ...identityOptions, ready, monitor,
      routes: [...(gatewayOptions.routes ?? []), ...(identityOptions.routes ?? [])],
    }),
  );
  return { gateway, metrics: monitor ? createMetricsServer(monitor) : null };
}

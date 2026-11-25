import { createServer } from 'node:http';
import { createGatewayMonitor } from '../../../infra/monitoring/gateway-monitor.mjs';
import { createApiReadinessProbe, createMetricsServer } from '../../../infra/monitoring/runtime.mjs';
import { createGateway } from './gateway.mjs';

export function createGatewayRuntime({ monitoring, gatewayOptions = {}, emit } = {}) {
  const monitor = monitoring && createGatewayMonitor({ mode: monitoring.mode, emit });
  const ready = monitoring?.apiPort ? createApiReadinessProbe(monitoring.apiPort) : gatewayOptions.ready;
  const gateway = createServer(
    { requestTimeout: 30_000, headersTimeout: 10_000 },
    createGateway({ ...gatewayOptions, ready, monitor }),
  );
  return { gateway, metrics: monitor ? createMetricsServer(monitor) : null };
}

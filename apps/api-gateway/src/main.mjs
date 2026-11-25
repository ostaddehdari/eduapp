import { readMonitoringOptions } from '../../../infra/monitoring/runtime.mjs';
import { createGatewayRuntime } from './runtime.mjs';

const port = Number(process.env.GATEWAY_PORT ?? 3010);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid GATEWAY_PORT');
const monitoring = readMonitoringOptions(process.env, port);
const { gateway, metrics } = createGatewayRuntime({ monitoring });
metrics?.listen(monitoring.metricsPort, '127.0.0.1');
gateway.listen(port, '127.0.0.1', () => process.stdout.write('Gateway listening on 127.0.0.1:' + port + '\n'));

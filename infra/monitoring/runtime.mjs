import { createServer, get } from 'node:http';
import { monitoringModes } from './gateway-monitor.mjs';

function readPort(value, name) {
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`Invalid ${name}`);
  }
  return Number(value);
}

export function readMonitoringOptions(env, gatewayPort) {
  const mode = env.EDUAPP_MONITORING_MODE;
  if (mode === undefined) return null;
  if (!monitoringModes.includes(mode)) throw new Error('Invalid EDUAPP_MONITORING_MODE');

  const metricsPort = readPort(env.EDUAPP_METRICS_PORT ?? '9464', 'EDUAPP_METRICS_PORT');
  const apiPort = env.EDUAPP_READINESS_API_PORT === undefined ? null :
    readPort(env.EDUAPP_READINESS_API_PORT, 'EDUAPP_READINESS_API_PORT');
  if (mode === 'staging' && apiPort === null) throw new Error('EDUAPP_READINESS_API_PORT is required in staging');
  if (metricsPort === gatewayPort || apiPort === gatewayPort || apiPort === metricsPort) {
    throw new Error('Gateway, metrics and API readiness ports must be distinct');
  }
  return { mode, metricsPort, apiPort };
}

export function createApiReadinessProbe(port) {
  return ({ requestId, traceparent }) => new Promise((resolve) => {
    const request = get({
      hostname: '127.0.0.1',
      port,
      path: '/api/health',
      headers: { 'X-Request-Id': requestId, traceparent },
      signal: AbortSignal.timeout(1000),
    }, (response) => {
      resolve(response.statusCode === 200);
      response.destroy();
    });
    request.once('error', () => resolve(false));
  });
}

export function createMetricsServer(monitor) {
  return createServer({ requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    const headers = { 'Cache-Control': 'no-store' };
    if (req.url !== '/metrics') {
      res.writeHead(404, headers).end();
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { ...headers, Allow: 'GET' }).end();
      return;
    }
    res.writeHead(200, { ...headers, 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(monitor.renderMetrics());
  });
}

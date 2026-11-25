import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('../../preview/api/openapi.json', import.meta.url), 'utf8'));
const operations = new Set(Object.values(catalog.paths).flatMap((item) =>
  Object.values(item).map((operation) => operation?.operationId).filter(Boolean),
));
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const buckets = [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5];
export const monitoringModes = Object.freeze(['development', 'staging']);

function writeRecord(record) {
  if (process.stdout.destroyed || process.stdout.writableNeedDrain) return false;
  process.stdout.write(JSON.stringify(record) + '\n');
  return true;
}

function newId(bytes) {
  return randomBytes(bytes).toString('hex');
}

export function createGatewayMonitor({ mode, emit = writeRecord }) {
  if (!monitoringModes.includes(mode)) throw new Error('Invalid monitoring mode');
  const requests = new Map();
  const durations = new Map();
  let readiness = null;
  let probeSequence = 0;
  let lastAppliedProbe = 0;
  let dropped = 0;

  function record(event, fields) {
    try {
      if (emit({ version: 1, event, mode, service: 'api-gateway', timestamp: new Date().toISOString(), ...fields }) === false) {
        dropped += 1;
      }
    } catch {
      dropped += 1;
    }
  }

  function startRequest(candidate, candidateMethod) {
    const requestId = typeof candidate === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)
      ? candidate : randomUUID();
    const traceId = newId(16);
    const spanId = newId(8);
    const method = methods.has(candidateMethod) ? candidateMethod : 'OTHER';
    const start = performance.now();
    let operation = 'unmatched';
    let finished = false;

    return {
      setOperation(candidateOperation) {
        operation = operations.has(candidateOperation) ? candidateOperation : 'unmatched';
      },

      async checkReadiness(probe) {
        const sequence = ++probeSequence;
        const childId = newId(8);
        const probeStart = performance.now();
        let ready;
        try {
          ready = await probe({ requestId, traceparent: `00-${traceId}-${childId}-01` }) === true;
        } catch {
          ready = false;
        }
        const correlation = { request_id: requestId, trace_id: traceId, span_id: childId, parent_span_id: spanId };
        record('gateway.readiness.checked', { ...correlation, ready, duration_ms: performance.now() - probeStart });
        if (sequence > lastAppliedProbe) {
          lastAppliedProbe = sequence;
          const previous = readiness;
          readiness = ready;
          if (!ready && previous !== false) {
            record('gateway.alert', { ...correlation, name: 'GatewayReadiness', state: 'firing' });
          } else if (ready && previous === false) {
            record('gateway.alert', { ...correlation, name: 'GatewayReadiness', state: 'resolved' });
          }
        }
        return ready;
      },

      finish(candidateStatus) {
        if (finished) return;
        finished = true;
        const status = Number.isInteger(candidateStatus) && candidateStatus >= 100 && candidateStatus <= 599
          ? candidateStatus : 0;
        const duration = performance.now() - start;
        const label = `operation="${operation}",method="${method}"`;
        const requestLabel = `${label},status="${status}"`;
        requests.set(requestLabel, (requests.get(requestLabel) ?? 0) + 1);
        const entry = durations.get(label) ?? { count: 0, sum: 0, buckets: buckets.map(() => 0) };
        const seconds = duration / 1000;
        entry.count += 1;
        entry.sum += seconds;
        for (const [index, limit] of buckets.entries()) {
          if (seconds <= limit) entry.buckets[index] += 1;
        }
        durations.set(label, entry);
        record('gateway.request.completed', {
          request_id: requestId, trace_id: traceId, span_id: spanId, operation, method, status, duration_ms: duration,
        });
      },
    };
  }

  function renderMetrics() {
    const lines = [
      '# HELP eduapp_gateway_http_requests_total Completed Gateway HTTP requests. Status 0 indicates interrupted responses.',
      '# TYPE eduapp_gateway_http_requests_total counter',
    ];
    for (const [label, count] of requests) lines.push(`eduapp_gateway_http_requests_total{${label}} ${count}`);
    lines.push(
      '# HELP eduapp_gateway_http_duration_seconds Gateway HTTP response duration in seconds.',
      '# TYPE eduapp_gateway_http_duration_seconds histogram',
    );
    for (const [label, entry] of durations) {
      for (const [i, limit] of buckets.entries()) {
        lines.push(`eduapp_gateway_http_duration_seconds_bucket{${label},le="${limit}"} ${entry.buckets[i]}`);
      }
      lines.push(
        `eduapp_gateway_http_duration_seconds_bucket{${label},le="+Inf"} ${entry.count}`,
        `eduapp_gateway_http_duration_seconds_sum{${label}} ${entry.sum}`,
        `eduapp_gateway_http_duration_seconds_count{${label}} ${entry.count}`,
      );
    }
    lines.push(
      '# HELP eduapp_gateway_readiness Gateway readiness after the latest completed probe.',
      '# TYPE eduapp_gateway_readiness gauge',
    );
    if (readiness !== null) lines.push(`eduapp_gateway_readiness ${Number(readiness)}`);
    lines.push(
      '# HELP eduapp_gateway_telemetry_dropped_total Structured records dropped because the sink was unavailable.',
      '# TYPE eduapp_gateway_telemetry_dropped_total counter',
      `eduapp_gateway_telemetry_dropped_total ${dropped}`,
    );
    return lines.join('\n') + '\n';
  }

  return { startRequest, renderMetrics };
}

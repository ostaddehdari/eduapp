import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMemoryCursorStore, createMemoryRateLimiter } from './limits.mjs';

export const contract = JSON.parse(readFileSync(new URL('../../../docs/contracts/S02-W02.json', import.meta.url)));
const catalog = JSON.parse(readFileSync(new URL('../../../preview/api/openapi.json', import.meta.url)));
const runtimeVersion = JSON.parse(readFileSync(new URL('../../../apps/api/package.json', import.meta.url))).version;
const methods = new Set(['get', 'post', 'patch', 'put', 'delete']);
const routesById = new Map();
for (const [path, item] of Object.entries(catalog.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (methods.has(method)) routesById.set(operation.operationId, { path, method: method.toUpperCase(), operation });
  }
}

const errors = new Map([
  ['INVALID_REQUEST', [400, 'The request is invalid.']],
  ['AUTHENTICATION_REQUIRED', [401, 'Authentication is required.']],
  ['FORBIDDEN', [403, 'Access denied.']],
  ['NOT_FOUND', [404, 'Resource not found.']],
  ['CONFLICT', [409, 'The operation conflicts with the current state.']],
  ['IDEMPOTENCY_CONFLICT', [409, 'The key was used for a different request.']],
  ['IDEMPOTENCY_IN_PROGRESS', [409, 'A request for this key is in progress.']],
  ['PAYLOAD_TOO_LARGE', [413, 'The request body is too large.']],
  ['PRECONDITION_FAILED', [412, 'The resource revision has changed.']],
  ['VALIDATION_FAILED', [422, 'The request did not meet validation requirements.']],
  ['PRECONDITION_REQUIRED', [428, 'A resource revision is required.']],
  ['RATE_LIMITED', [429, 'Too many requests.']],
  ['SERVICE_UNAVAILABLE', [503, 'The operation is temporarily unavailable.']],
]);

export class GatewayError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = code => { throw new GatewayError(code); };
const unavailable = () => fail('SERVICE_UNAVAILABLE');
const invalid = () => fail('INVALID_REQUEST');

function write(res, status, headers, body) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  res.writeHead(status, json === undefined ? headers : { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(json);
}

function matchPath(template, path) {
  const pattern = template.split('/');
  const segments = path.split('/');
  if (pattern.length !== segments.length) return null;
  const params = {};
  for (const [i, part] of pattern.entries()) {
    if (!part.startsWith('{')) {
      if (part !== segments[i]) return null;
      continue;
    }
    let value;
    try { value = decodeURIComponent(segments[i]); } catch { invalid(); }
    if (!value || /[\/\\\u0000-\u001f\u007f]/.test(value)) invalid();
    params[part.slice(1, -1)] = value;
  }
  return params;
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key]));
    return '{' + entries.join(',') + '}';
  }
  return JSON.stringify(value);
}

function queryObject(params, allowed) {
  const result = Object.create(null);
  for (const [key, value] of params) {
    if (!allowed.has(key) || Object.hasOwn(result, key) || value.length > 2048) invalid();
    result[key] = value;
  }
  return result;
}

async function readBody(req) {
  if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') invalid();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 65_536) {
      req.resume();
      fail('PAYLOAD_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { invalid(); }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') invalid();
  return parsed;
}

function register(config) {
  const entry = routesById.get(config.id);
  if (!entry || typeof config.handle !== 'function') throw new TypeError('Unknown or incomplete Gateway route');
  const publicRoute = Array.isArray(entry.operation.security) && entry.operation.security.length === 0;
  const paged = contract.pagination.operation_ids.includes(config.id);
  const idempotent = contract.idempotency.client_operations.includes(config.id);
  const versioned = contract.concurrency.required_operations.includes(config.id);
  if (config.id === contract.routing.provider_callback_operation) {
    throw new TypeError('Provider callbacks require a separate verified adapter');
  }
  if (!publicRoute && typeof config.authorize !== 'function') throw new TypeError('Owner authorization is required');
  if (idempotent && typeof config.executeIdempotent !== 'function') throw new TypeError('Owner idempotency storage is required');
  const budget = config.budget;
  if (config.id !== 'getLiveness' && (!budget ||
    !Number.isSafeInteger(budget.max) || budget.max < 1 ||
    !Number.isSafeInteger(budget.windowSeconds) || budget.windowSeconds < 1)) {
    throw new TypeError('A positive per-route rate budget is required');
  }
  const allowed = new Set(config.queryKeys ?? []);
  if (paged) {
    allowed.add('limit');
    allowed.add('cursor');
  }
  return { ...config, ...entry, paged, idempotent, versioned, publicRoute, allowed };
}

export function createGateway({
  routes = [],
  authenticate,
  limiter = createMemoryRateLimiter(),
  cursors = createMemoryCursorStore(),
  ready = () => true,
  monitor,
  systemBudget = { max: 60, windowSeconds: 60 },
} = {}) {
  const system = [
    { id: 'getLiveness', handle: () => ({ data: { status: 'ok' } }) },
    { id: 'getReadiness', budget: systemBudget, handle: async (_input, span) => {
      const isReady = span ? await span.checkReadiness(ready) : await ready();
      if (!isReady) unavailable();
      return { data: { status: 'ok' } };
    } },
    { id: 'getVersion', budget: systemBudget, handle: () => ({ data: { version: runtimeVersion } }) },
  ];
  const registry = [...system, ...routes].map(register);
  if (new Set(registry.map(route => route.id)).size !== registry.length) throw new TypeError('Duplicate Gateway route');
  registry.sort((a, b) => Number(a.path.includes('{')) - Number(b.path.includes('{')));

  return async function gateway(req, res) {
    const responseHeaders = { 'X-Request-Id': randomUUID(), 'Cache-Control': 'no-store' };
    const requestId = responseHeaders['X-Request-Id'];
    const span = monitor?.startRequest(requestId, req.method);
    if (span) {
      res.once('finish', () => span.finish(res.statusCode));
      res.once('close', () => span.finish(0));
    }
    try {
      if (typeof req.url !== 'string' || !req.url.startsWith('/') || req.url.startsWith('//')) invalid();
      const question = req.url.indexOf('?');
      const path = question === -1 ? req.url : req.url.slice(0, question);
      if (!path.startsWith('/v1/')) fail('NOT_FOUND');
      let selected, params;
      for (const route of registry) {
        if (route.method !== req.method) continue;
        const candidate = matchPath(route.path, path.slice(3));
        if (candidate !== null) {
          selected = route;
          params = candidate;
          break;
        }
      }
      if (!selected) fail('NOT_FOUND');
      const route = selected;
      span?.setOperation(route.id);
      let identity;
      if (!route.publicRoute) {
        identity = await authenticate?.(req.headers.authorization);
        if (!identity || typeof identity.actor !== 'string' || !identity.actor ||
          typeof identity.scope !== 'string' || !identity.scope) {
          responseHeaders['WWW-Authenticate'] = 'Bearer';
          fail('AUTHENTICATION_REQUIRED');
        }
      }

      if (route.budget) {
        const partition = identity ? ['actor', identity.scope, identity.actor] : ['peer', req.socket.remoteAddress];
        const quota = await limiter.consume(JSON.stringify([...partition, route.id]), route.budget);
        if (!quota || (quota.retryAfter !== null && (!Number.isSafeInteger(quota.retryAfter) || quota.retryAfter < 1))) unavailable();
        if (quota.retryAfter !== null) {
          responseHeaders['Retry-After'] = String(quota.retryAfter);
          fail('RATE_LIMITED');
        }
      }

      const query = queryObject(new URLSearchParams(question === -1 ? '' : req.url.slice(question + 1)), route.allowed);
      const rawCursor = query.cursor;
      const rawLimit = query.limit;
      delete query.cursor;
      delete query.limit;
      const limit = rawLimit === undefined ? contract.pagination.limit_default : Number(rawLimit);
      if (route.paged && ((rawLimit !== undefined && !/^[1-9]\d{0,2}$/.test(rawLimit)) ||
        !Number.isInteger(limit) || limit > contract.pagination.limit_max)) invalid();

      const ifMatch = req.headers['if-match'];
      if (route.versioned && ifMatch === undefined) fail('PRECONDITION_REQUIRED');
      if (route.versioned && (typeof ifMatch !== 'string' || !/^"[\x21\x23-\x7e]{1,254}"$/.test(ifMatch))) invalid();

      const body = ['POST', 'PUT', 'PATCH'].includes(route.method) ? await readBody(req) : undefined;
      const input = { identity, params, query, body, ifMatch, requestId };
      if (route.authorize && await route.authorize(input) !== true) fail('NOT_FOUND');

      let binding;
      if (route.paged) {
        binding = canonical([route.id, identity?.scope ?? null, identity?.actor ?? null, params, query, limit]);
        let position = null;
        if (rawCursor !== undefined) {
          if (!/^[A-Za-z0-9_-]{43}$/.test(rawCursor)) invalid();
          position = await cursors.read(rawCursor, binding);
          if (position === undefined) invalid();
        }
        input.page = { position, limit };
      }

      let result;
      if (route.idempotent) {
        const key = req.headers['idempotency-key'];
        if (typeof key !== 'string' || !/^[\x21-\x7e]+$/.test(key) || key.includes(',') ||
          key.length < contract.idempotency.key_min_length || key.length > contract.idempotency.key_max_length) invalid();
        const namespace = [identity.scope, identity.actor, route.id, key];
        const fingerprint = createHash('sha256').update(canonical([route.method, route.path, params, query, body])).digest('hex');
        result = await route.executeIdempotent({ namespace, fingerprint }, () => route.handle(input));
      } else if (span && route.id === 'getReadiness') {
        result = await route.handle(input, span);
      } else {
        result = await route.handle(input);
      }

      const status = result?.status ?? 200;
      if (!Number.isInteger(status) || status < 200 || status > 299) unavailable();
      if (status === 204) {
        if (route.paged || !route.operation.responses['204']) unavailable();
        write(res, status, responseHeaders);
        return;
      }
      if (!result || result.data === undefined) unavailable();
      if (result.etag !== undefined) {
        if (typeof result.etag !== 'string' || !/^"[\x21\x23-\x7e]{1,254}"$/.test(result.etag)) unavailable();
        responseHeaders.ETag = result.etag;
      }
      const meta = { version: 'v1', requestId };
      if (route.paged) {
        if (!Array.isArray(result.data) || result.data.length > limit || result.nextPosition === undefined) unavailable();
        meta.nextCursor = result.nextPosition === null ? null :
          await cursors.issue(binding, result.nextPosition, contract.pagination.cursor_ttl_seconds);
      }
      write(res, status, responseHeaders, { data: result.data, meta });
    } catch (err) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const code = err instanceof GatewayError && errors.has(err.code) ? err.code : 'SERVICE_UNAVAILABLE';
      if (code === 'AUTHENTICATION_REQUIRED') responseHeaders['WWW-Authenticate'] ??= 'Bearer';
      const [status, message] = errors.get(code);
      if (code === 'RATE_LIMITED' && !responseHeaders['Retry-After']) {
        write(res, 503, responseHeaders, { error: { code: 'SERVICE_UNAVAILABLE', message: errors.get('SERVICE_UNAVAILABLE')[1], details: [] }, meta: { requestId } });
        return;
      }
      write(res, status, responseHeaders, { error: { code, message, details: [] }, meta: { requestId } });
    }
  };
}

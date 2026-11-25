export const contractPaths = {
  active: 'packages/contracts/openapi/gateway-active-v1.json',
  catalog: 'preview/api/openapi.json',
  sdk: 'packages/contracts/src/gateway-sdk.generated.ts',
};

const httpMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);

export function operationEntries(spec) {
  const entries = new Map();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(item)) {
      if (httpMethods.has(method)) entries.set(method + ' ' + path, { path, method, operation, item });
    }
  }
  return entries;
}

function dereference(spec, value, seen = new Set()) {
  if (!value || typeof value.$ref !== 'string') return value;
  const key = value.$ref;
  if (Object.keys(value).some(name => !['$ref', 'description', 'summary'].includes(name))) {
    throw new Error('Reference siblings require compatibility review: ' + key);
  }
  if (!key.startsWith('#/') || seen.has(key)) throw new Error('Unsupported reference: ' + key);
  const target = key.slice(2).split('/').reduce((object, step) => object?.[step.replaceAll('~1', '/').replaceAll('~0', '~')], spec);
  if (!target) throw new Error('Unknown reference: ' + key);
  return dereference(spec, target, new Set([...seen, key]));
}

function normalize(spec, value, stack = new Set()) {
  if (value?.$ref) {
    if (stack.has(value.$ref)) return value;
    return normalize(spec, dereference(spec, value), new Set([...stack, value.$ref]));
  }
  if (Array.isArray(value)) return value.map(item => normalize(spec, item, stack));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, inner]) => [key, normalize(spec, inner, stack)]));
}

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const handled = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'description', 'title', 'examples', 'example', 'default', 'deprecated', 'format', 'pattern']);
const substantial = schema => Object.fromEntries(Object.entries(schema).filter(([key]) => !handled.has(key)));

function accepts(from, to) {
  if (from === false || to === true || to === undefined || equal(from, to)) return true;
  if (to === false) return false;
  if (from === true || from === undefined) from = {};
  if (!equal(substantial(from), substantial(to))) return false;
  if (to.type !== undefined) {
    const target = [to.type].flat();
    if (from.type === undefined || ![from.type].flat().every(type => target.includes(type) || type === 'integer' && target.includes('number'))) return false;
  }
  const allowed = schema => 'const' in schema ? [schema.const] : schema.enum;
  if (allowed(to) && !allowed(from)?.every(value => allowed(to).some(item => equal(item, value)))) return false;
  for (const key of ['minimum', 'minLength', 'minItems']) {
    if (to[key] !== undefined && !(from[key] >= to[key])) return false;
  }
  for (const key of ['maximum', 'maxLength', 'maxItems']) {
    if (to[key] !== undefined && !(from[key] <= to[key])) return false;
  }
  for (const key of ['format', 'pattern']) if (to[key] !== undefined && from[key] !== to[key]) return false;
  if (to.items !== undefined && !accepts(from.items, to.items)) return false;
  if (!(to.required ?? []).every(key => (from.required ?? []).includes(key))) return false;

  const fromFields = from.properties ?? {};
  const toFields = to.properties ?? {};
  for (const [name, schema] of Object.entries(toFields)) {
    const existing = Object.hasOwn(fromFields, name) ? fromFields[name] : from.additionalProperties;
    if (!accepts(existing, schema)) return false;
  }
  if (to.additionalProperties !== undefined) {
    if (!accepts(from.additionalProperties, to.additionalProperties)) return false;
    for (const [name, schema] of Object.entries(fromFields)) {
      if (!Object.hasOwn(toFields, name) && !accepts(schema, to.additionalProperties)) return false;
    }
  }
  return true;
}

function fieldsPreserved(previous, next) {
  if (equal(previous, next) || !previous || typeof previous !== 'object') return true;
  if (!next || typeof next !== 'object') return !previous.properties && !previous.items;
  return Object.entries(previous.properties ?? {}).every(([name, schema]) =>
    Object.hasOwn(next.properties ?? {}, name) && fieldsPreserved(schema, next.properties[name])) &&
    (!previous.items || fieldsPreserved(previous.items, next.items));
}

function parameterMap(spec, { operation, item }) {
  return new Map([...(item.parameters ?? []), ...(operation.parameters ?? [])]
    .map(param => dereference(spec, param))
    .map(param => [param.in + ':' + param.name, param]));
}

function checkContent(previous, next, visit) {
  for (const [type, oldMedia] of Object.entries(previous ?? {})) {
    const newMedia = next?.[type];
    if (!newMedia || !visit(oldMedia.schema, newMedia.schema)) return false;
  }
  return true;
}

export function checkCompatibility(previous, current) {
  const changes = [];
  const currentOps = operationEntries(current);
  if (previous.servers?.[0]?.url !== current.servers?.[0]?.url) changes.push('Default server URL changed');
  for (const [key, oldEntry] of operationEntries(previous)) {
    const newEntry = currentOps.get(key);
    if (!newEntry) {
      changes.push(key + ' removed');
      continue;
    }
    const oldOp = oldEntry.operation;
    const newOp = newEntry.operation;
    if (oldOp.operationId !== newOp.operationId) changes.push(key + ' operationId changed');
    if (!equal(oldOp.security ?? previous.security, newOp.security ?? current.security)) changes.push(key + ' authentication changed');

    const oldParams = parameterMap(previous, oldEntry);
    const newParams = parameterMap(current, newEntry);
    for (const [name, a] of oldParams) {
      const b = newParams.get(name);
      if (!b || b.required && !a.required ||
        !accepts(normalize(previous, a.schema), normalize(current, b.schema))) changes.push(key + ' request parameter changed incompatibly: ' + name);
    }
    for (const [name, b] of newParams) if (b.required && !oldParams.has(name)) changes.push(key + ' new required parameter: ' + name);

    const oldBody = dereference(previous, oldOp.requestBody);
    const newBody = dereference(current, newOp.requestBody);
    if (newBody?.required && !oldBody?.required || oldBody && (!newBody ||
      !checkContent(oldBody.content, newBody.content, (a, b) => accepts(normalize(previous, a), normalize(current, b))))) {
      changes.push(key + ' request body changed incompatibly');
    }
    for (const [status, oldResponse] of Object.entries(oldOp.responses ?? {})) {
      const a = dereference(previous, oldResponse);
      const b = dereference(current, newOp.responses?.[status]);
      const newHeaders = new Map(Object.entries(b?.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
      const headersPreserved = Object.entries(a.headers ?? {}).every(([name, value]) => {
        const oldHeader = dereference(previous, value);
        const newHeader = dereference(current, newHeaders.get(name.toLowerCase()));
        return newHeader && (!oldHeader.required || newHeader.required) &&
          accepts(normalize(current, newHeader.schema), normalize(previous, oldHeader.schema));
      });
      if (!b || !headersPreserved || !checkContent(a.content, b.content, (oldSchema, newSchema) => {
        const x = normalize(previous, oldSchema);
        const y = normalize(current, newSchema);
        return accepts(y, x) && fieldsPreserved(x, y);
      })) changes.push(key + ' response changed incompatibly: ' + status);
    }
  }
  return changes;
}

function toType(spec, value) {
  if (value?.$ref) {
    if (!/^#\/components\/schemas\/[A-Za-z][A-Za-z0-9]*$/.test(value.$ref)) throw new Error('Unsupported SDK schema ref');
    return value.$ref.split('/').at(-1);
  }
  if (!value) return 'unknown';
  if ('const' in value) return JSON.stringify(value.const);
  if (value.enum) return value.enum.map(option => JSON.stringify(option)).join(' | ');
  if (value.type === 'object') {
    const properties = Object.entries(value.properties ?? {}).map(([name, prop]) =>
      JSON.stringify(name) + ((value.required ?? []).includes(name) ? '' : '?') + ': ' + toType(spec, prop));
    return '{ ' + properties.join('; ') + ' }';
  }
  if (value.type === 'array') return 'Array<' + toType(spec, value.items) + '>';
  if (['string', 'boolean', 'null'].includes(value.type)) return value.type;
  if (['integer', 'number'].includes(value.type)) return 'number';
  throw new Error('Unsupported SDK schema');
}

export function generateSdk(spec) {
  const types = Object.entries(spec.components.schemas).map(([name, schema]) => {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) throw new Error('Invalid SDK type name');
    return 'export type ' + name + ' = ' + toType(spec, schema) + ';';
  });
  const calls = [...operationEntries(spec).values()].map(({ path, method, operation, item }) => {
    if (method !== 'get' || path.includes('{') || parameterMap(spec, { operation, item }).size ||
      operation.requestBody || !equal(operation.security ?? spec.security, []) ||
      !/^[a-z][A-Za-z0-9]*$/.test(operation.operationId)) throw new Error('Unsupported SDK operation');
    const type = toType(spec, operation.responses['200'].content['application/json'].schema);
    return '    ' + operation.operationId + ': (signal?: AbortSignal) => get<' + type + '>(' + JSON.stringify(path) + ', signal),';
  });
  return [
    '// Generated by scripts/gateway-contract-tools.mjs. Do not edit.',
    ...types, '',
    'export class GatewayApiError extends Error {',
    '  constructor(public readonly status: number, public readonly requestId: string | null, public readonly body: unknown) {',
    '    super("EduApp Gateway returned HTTP " + status);',
    '  }',
    '}',
    '',
    'export function createGatewayClient(baseUrl: string, fetcher: typeof fetch = fetch) {',
    '  const base = new URL(baseUrl);',
    '  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {',
    '    throw new TypeError("Invalid Gateway base URL");',
    '  }',
    '  base.pathname = base.pathname.replace(/\\/+$/, "") + "/";',
    '  async function get<T>(path: string, signal?: AbortSignal): Promise<T> {',
    '    const response = await fetcher(new URL(path.slice(1), base), signal ? { signal } : {});',
    '    const body: unknown = await response.json().catch(() => undefined);',
    '    if (!response.ok) throw new GatewayApiError(response.status, response.headers.get("x-request-id"), body);',
    '    if (body === undefined) throw new TypeError("Invalid Gateway JSON response");',
    '    return body as T;',
    '  }',
    '  return {', ...calls, '  };', '}', '',
  ].join('\n');
}

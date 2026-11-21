import { readFile } from 'node:fs/promises';

const spec = JSON.parse(await readFile(new URL('../preview/api/openapi.json', import.meta.url), 'utf8'));
const landing = await readFile(new URL('../preview/index.html', import.meta.url), 'utf8');
const swagger = await readFile(new URL('../preview/api/docs/index.html', import.meta.url), 'utf8');

if (spec.openapi !== '3.1.0') throw new Error('OpenAPI 3.1.0 is required');
if (!spec.servers?.some((entry) => entry.url === 'https://srun.ir/eduapp/api/v1')) throw new Error('Production base URL missing');
const operations = Object.values(spec.paths).flatMap((path) => Object.values(path)).filter((operation) => operation?.operationId);
if (operations.length < 45) throw new Error(`Expected at least 45 documented operations; got ${operations.length}`);
const ids = operations.map((operation) => operation.operationId);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate operationId detected');
if (!landing.includes('./api/docs/')) throw new Error('Landing page does not link to Swagger');
if (!swagger.includes("url:'../openapi.json'")) throw new Error('Swagger page does not load local OpenAPI document');
console.log(`PASS preview contract: ${operations.length} operations, Swagger path and production base URL`);

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkCompatibility, contractPaths, generateSdk, operationEntries } from './gateway-contract-tools.mjs';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const active = JSON.parse(read(contractPaths.active));
const catalog = JSON.parse(read(contractPaths.catalog));
const catalogOps = operationEntries(catalog);
for (const [key, { operation }] of operationEntries(active)) {
  assert.equal(operation.operationId, catalogOps.get(key)?.operation.operationId, 'Active route must match the catalog');
}
const output = generateSdk(active);
const command = process.argv[2];
if (command === 'generate') {
  writeFileSync(resolve(root, contractPaths.sdk), output, 'utf8');
} else if (command === 'check') {
  assert.equal(read(contractPaths.sdk), output, 'Generated Gateway SDK is stale');
  const base = process.argv[3];
  if (base !== undefined) {
    assert.match(base, /^[0-9a-f]{40}$/);
    const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git(['rev-parse', '--verify', base + '^{commit}']);
    for (const [name, path] of Object.entries(contractPaths)) {
      if (name === 'sdk') continue;
      if (name === 'active' && !git(['ls-tree', '--name-only', base, '--', path]).trim()) continue;
      const previous = JSON.parse(git(['show', base + ':' + path]));
      const changes = checkCompatibility(previous, name === 'active' ? active : catalog);
      assert.deepEqual(changes, [], path + ' has breaking changes');
    }
    console.log('Gateway API compatibility verified against PR base ' + base);
  }
  console.log('Generated Gateway SDK matches the executable public OpenAPI contract.');
} else {
  throw new Error('Use generate or check [base SHA]');
}

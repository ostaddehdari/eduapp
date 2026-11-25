import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { welcomeTitle } from '../../apps/control-panel/src/app-model.ts';
import { validateBoundaries, validateRepository } from '../../infra/ci/validate.mjs';

const root = resolve(import.meta.dirname, '../..');
const contractPath = 'docs/contracts/S02-W01.json';
const contract = JSON.parse(readFileSync(join(root, contractPath), 'utf8'));
const units = [...contract.monorepo.runtime_units, ...contract.monorepo.shared_units];
const panel = 'apps/control-panel';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'eduapp-s02-w01-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = [
    contractPath,
    '.github/CODEOWNERS',
    '.github/workflows/ci.yml',
    'infra/ci/main-protection.json',
    'pnpm-lock.yaml',
    ...units.map(({ path }) => path + '/package.json'),
  ];

  for (const file of files) {
    const target = join(dir, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, file), target);
  }
  return dir;
}

function write(dir, path, value) {
  const target = join(dir, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value, 'utf8');
}

test('the real checkout satisfies CODEOWNERS, CI policy and dependency boundaries', () => {
  validateRepository();
  validateBoundaries();
});

test('two synthetic schools get distinct titles and invalid input does not affect the next title', () => {
  const firstSchool = 'مدرسه آفتاب';
  const secondSchool = 'مدرسه باران';
  assert.equal(welcomeTitle(firstSchool), 'خوش آمدید، مدرسه آفتاب');
  assert.equal(welcomeTitle('  ' + secondSchool + '  '), 'خوش آمدید، مدرسه باران');
  assert.throws(() => welcomeTitle('  '), { message: 'TENANT_NAME_REQUIRED' });
  assert.equal(welcomeTitle(secondSchool), 'خوش آمدید، مدرسه باران');
  assert.equal(welcomeTitle(firstSchool), 'خوش آمدید، مدرسه آفتاب');
});

test('the dependency validator accepts a declared workspace contract', (t) => {
  const dir = fixture(t);
  const manifest = JSON.parse(readFileSync(join(dir, panel, 'package.json'), 'utf8'));
  manifest.dependencies['@eduapp/contracts'] = 'workspace:*';
  write(dir, panel + '/package.json', JSON.stringify(manifest));
  write(dir, panel + '/src/example.ts', "import { contractVersion } from '@eduapp/contracts';");
  validateBoundaries(dir);
});

test('the dependency validator rejects an undeclared workspace contract', (t) => {
  const dir = fixture(t);
  write(dir, panel + '/src/example.ts', "import { contractVersion } from '@eduapp/contracts';");
  assert.throws(() => validateBoundaries(dir), /example\.ts imports @eduapp\/contracts/);
});

test('the dependency validator rejects direct backend imports from the panel', (t) => {
  const dir = fixture(t);
  write(dir, panel + '/src/example.ts', "import '../../api/src/app.js';");
  assert.throws(() => validateBoundaries(dir), /example\.ts imports \.\.\/\.\.\/api/);
});

test('the dependency validator rejects a shared package importing an app', (t) => {
  const dir = fixture(t);
  write(dir, 'packages/config/src/example.ts', "export * from '@eduapp/worker';");
  assert.throws(() => validateBoundaries(dir), /example\.ts imports @eduapp\/worker/);
});

test('the dependency validator rejects a database import inside a Vue component', (t) => {
  const dir = fixture(t);
  write(dir, 'apps/public-web/app/example.vue', '<script setup lang="ts">import "pg";</script>');
  assert.throws(() => validateBoundaries(dir), /example\.vue imports pg/);
});

test('the repository validator rejects missing explicit ownership', (t) => {
  const dir = fixture(t);
  const path = '.github/CODEOWNERS';
  const rules = readFileSync(join(dir, path), 'utf8').split('\n');
  write(dir, path, rules.filter((line) => !line.startsWith('/apps/control-panel/ ')).join('\n'));
  assert.throws(() => validateRepository(dir), /CODEOWNERS must match/);
});

test('the repository validator rejects a missing required status check', (t) => {
  const dir = fixture(t);
  const path = 'infra/ci/main-protection.json';
  const protection = JSON.parse(readFileSync(join(dir, path), 'utf8'));
  const checks = protection.required_status_checks.contexts;
  assert.ok(checks.includes('ci / worker'));
  protection.required_status_checks.contexts = checks.filter((name) => name !== 'ci / worker');
  write(dir, path, JSON.stringify(protection));
  assert.throws(() => validateRepository(dir), /Required checks must match/);
});

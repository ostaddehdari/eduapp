import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const read = (root, path) => readFileSync(resolve(root, path), 'utf8');
const json = (root, path) => JSON.parse(read(root, path));
const contractPath = 'docs/contracts/S02-W01.json';
const frontendPaths = new Set(['apps/public-web', 'apps/control-panel']);
const databases = /^(?:pg|postgres|mysql2|better-sqlite3|typeorm|drizzle-orm|knex|@prisma\/client|@eduapp\/data)(?:\/|$)/;

export function validateRepository(root = repositoryRoot) {
  const contract = json(root, contractPath);
  const runtimeUnits = contract.monorepo.runtime_units;
  const owners = contract.ownership.codeowner_rules.map(({ pattern, github_owner }) => pattern + ' ' + github_owner);
  assert.deepEqual(read(root, '.github/CODEOWNERS').trimEnd().split('\n'), owners, 'CODEOWNERS must match the accepted contract');
  const protection = json(root, 'infra/ci/main-protection.json');
  assert.deepEqual(protection.required_status_checks, {
    strict: true,
    contexts: contract.ci_contract.required_checks.map(({ name }) => name),
  }, 'Required checks must match the accepted contract');
  assert.equal(protection.required_pull_request_reviews.required_approving_review_count, 0);
  assert.equal(protection.enforce_admins, true);
  assert.equal(protection.required_conversation_resolution, true);
  assert.equal(protection.allow_force_pushes, false);
  assert.equal(protection.allow_deletions, false);
  assert.match(read(root, 'pnpm-lock.yaml'), /^lockfileVersion:/m);
  const workflow = read(root, '.github/workflows/ci.yml');
  assert.match(workflow, /pull_request:\n\s+branches: \[main\]/);
  assert.doesNotMatch(workflow, /\b(?:pull_request_target|self-hosted|secrets\.)/);
  for (const use of workflow.matchAll(/uses:\s+([^\s#]+)/g)) assert.match(use[1], /@[0-9a-f]{40}$/);
  for (const runtime of runtimeUnits) {
    const manifest = json(root, runtime.path + '/package.json');
    assert.equal(manifest.name, '@eduapp/' + runtime.id);
    for (const command of runtime.required_commands) assert.ok(manifest.scripts[command]);
  }
  console.log('Repository policy, CODEOWNERS and six required checks validated.');
}

function* sourceFiles(path) {
  const ignored = new Set(['node_modules', 'dist', '.nuxt', '.output', 'coverage']);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(child);
    if (entry.isFile() && /\.(?:[cm]?[jt]sx?|vue)$/.test(entry.name)) yield child;
  }
}

function validateSpecifier({ root, unit, manifest, sharedNames }, specifier, file) {
  const label = relative(root, file) + ' imports ' + specifier;
  if (frontendPaths.has(unit.path)) assert.doesNotMatch(specifier, databases, label);
  if (specifier.startsWith('@eduapp/')) {
    const packageName = specifier.split('/').slice(0, 2).join('/');
    assert.ok(sharedNames.has(packageName), label);
    const declared = manifest.dependencies?.[packageName] ?? manifest.devDependencies?.[packageName];
    assert.match(declared ?? '', /^workspace:/, label);
  }
  if (specifier.startsWith('.')) {
    const target = relative(root, resolve(dirname(file), specifier)).replaceAll('\\', '/');
    assert.ok(target.startsWith(unit.path + '/'), label);
  }
}

function parseImports(context, file, text) {
  const { root } = context;
  const parsePath = extname(file) === '.vue' ? 'component.ts' : file;
  const ast = ts.createSourceFile(parsePath, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    let specifier;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      specifier = node.moduleReference.expression;
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      specifier = node.arguments[0];
      assert.ok(specifier && ts.isStringLiteralLike(specifier), relative(root, file) + ' has a nonliteral import');
    }
    if (specifier && ts.isStringLiteralLike(specifier)) validateSpecifier(context, specifier.text, file);
    ts.forEachChild(node, visit);
  }
  visit(ast);
}

export function validateBoundaries(root = repositoryRoot) {
  const { runtime_units: runtimes, shared_units: shared } = json(root, contractPath).monorepo;
  const units = [...runtimes, ...shared];
  const sharedNames = new Set(shared.map(({ id }) => '@eduapp/' + id));
  let count = 0;
  for (const unit of units) {
    const manifest = json(root, unit.path + '/package.json');
    const context = { root, unit, manifest, sharedNames };
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        validateSpecifier(context, name, resolve(root, unit.path, 'package.json'));
      }
    }
    for (const file of sourceFiles(resolve(root, unit.path))) {
      const source = readFileSync(file, 'utf8');
      if (extname(file) === '.vue') {
        for (const block of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) parseImports(context, file, block[1]);
      } else {
        parseImports(context, file, source);
      }
      count += 1;
    }
  }
  assert.ok(count > 0);
  console.log('Dependency boundaries validated across ' + count + ' source files.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  switch (process.argv[2]) {
    case 'repository': validateRepository(); break;
    case 'boundaries': validateBoundaries(); break;
    default: throw new Error('Expected repository or boundaries');
  }
}

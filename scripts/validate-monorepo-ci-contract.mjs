#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const contract = readJson('docs/contracts/S02-W01.json');
const boundary = readJson('docs/contracts/S01-W03.json');
const markdown = readFileSync(resolve(root, 'docs/contracts/S02-W01.md'), 'utf8');

assert.equal(contract.schema_version, '1.0');
assert.equal(contract.contract_id, 'S02-W01');
assert.equal(contract.version, '1.0.0');
assert.equal(contract.status, 'accepted');
assert.deepEqual(contract.requirement_ids, ['OPS-001']);
assert.equal(contract.scope, 'monorepo_and_ci_governance_contract_only');

assert.equal(contract.implementation_authorization.next_task, 'S02-W01-T02');
for (const key of ['create_workspace', 'change_branch_protection', 'deploy_production', 'write_production_data']) {
  assert.equal(contract.implementation_authorization[key], false, `${key} must remain unauthorized in T01`);
}

assert.equal(contract.monorepo.workspace_manager, 'pnpm');
assert.equal(contract.monorepo.lockfile_required, true);
const requiredCommands = ['lint', 'typecheck', 'test', 'build'];
const expectedRuntimes = new Map([
  ['api', ['NestJS', 'apps/api', 'backend']],
  ['worker', ['NestJS', 'apps/worker', 'backend']],
  ['public-web', ['Nuxt', 'apps/public-web', 'public_web']],
  ['control-panel', ['React', 'apps/control-panel', 'control_panel']]
]);
assert.equal(contract.monorepo.runtime_units.length, expectedRuntimes.size);

const workspacePaths = [];
for (const runtime of contract.monorepo.runtime_units) {
  const expected = expectedRuntimes.get(runtime.id);
  assert.ok(expected, `unknown runtime: ${runtime.id}`);
  assert.deepEqual([runtime.framework, runtime.path, runtime.owner], expected);
  assert.deepEqual(runtime.required_commands, requiredCommands, `incomplete commands: ${runtime.id}`);
  workspacePaths.push(runtime.path);
}
for (const shared of contract.monorepo.shared_units) {
  assert.equal(shared.may_import_apps, false, `shared package imports apps: ${shared.id}`);
  workspacePaths.push(shared.path);
}
assert.equal(new Set(workspacePaths).size, workspacePaths.length, 'DUPLICATE_WORKSPACE_PATH');

const dependencyRules = new Set(contract.monorepo.dependency_rules);
for (const rule of [
  'packages_must_not_import_apps',
  'frontends_must_not_import_backend_internals',
  'frontends_must_not_access_domain_database',
  'domain_repository_ownership_from_S01-W03_remains_enforced',
  'cross_context_access_uses_versioned_contracts'
]) assert.ok(dependencyRules.has(rule), `missing dependency rule: ${rule}`);

assert.equal(contract.ownership.github_bootstrap_owner, '@ostaddehdari');
const logicalOwners = new Set(contract.ownership.logical_owners);
assert.equal(logicalOwners.size, 7);
const codeownerPatterns = new Set();
for (const rule of contract.ownership.codeowner_rules) {
  assert.ok(logicalOwners.has(rule.logical_owner), `unknown logical owner: ${rule.logical_owner}`);
  assert.match(rule.github_owner, /^@[A-Za-z0-9-]+$/);
  assert.ok(!codeownerPatterns.has(rule.pattern), `duplicate CODEOWNERS pattern: ${rule.pattern}`);
  codeownerPatterns.add(rule.pattern);
}
for (const pattern of ['*', '/.github/', '/apps/api/', '/apps/worker/', '/apps/public-web/', '/apps/control-panel/', '/packages/contracts/', '/docs/contracts/', '/infra/ci/']) {
  assert.ok(codeownerPatterns.has(pattern), `missing CODEOWNERS path: ${pattern}`);
}

const repositoryArtifacts = new Set();
for (const item of contract.ownership.repository_data) {
  assert.ok(logicalOwners.has(item.owner), `unknown repository-data owner: ${item.owner}`);
  assert.ok(!repositoryArtifacts.has(item.artifact), `duplicate repository artifact: ${item.artifact}`);
  repositoryArtifacts.add(item.artifact);
}
assert.equal(repositoryArtifacts.size, 6);

const policy = contract.api_event_and_table_policy;
assert.deepEqual(policy.runtime_api_added_by_this_task, []);
assert.deepEqual(policy.domain_events_added_by_this_task, []);
assert.deepEqual(policy.database_tables_added_by_this_task, []);
assert.equal(policy.table_ownership_source_of_truth, boundary.contract_id);
assert.match(policy.ci_database_rule, /no production database credentials/);

assert.deepEqual(contract.ci_contract.trigger, { event: 'pull_request', target_branch: 'main' });
assert.deepEqual(contract.ci_contract.permissions, {
  default: 'contents:read',
  pull_requests: 'read',
  id_token: 'none'
});
const expectedChecks = new Map([
  ['ci / repository-policy', ['validate-contracts', 'validate-codeowners', 'validate-boundaries']],
  ['ci / api', requiredCommands],
  ['ci / worker', requiredCommands],
  ['ci / public-web', requiredCommands],
  ['ci / control-panel', requiredCommands],
  ['ci / dependency-boundaries', ['validate-boundaries']]
]);
assert.equal(contract.ci_contract.required_checks.length, expectedChecks.size);
for (const check of contract.ci_contract.required_checks) {
  assert.deepEqual(check.commands, expectedChecks.get(check.name), `REQUIRED_CHECK_MISSING: ${check.name}`);
}

const protection = contract.ci_contract.branch_protection_target;
assert.equal(protection.pull_request_required, true);
assert.equal(protection.required_checks_strict, true);
assert.equal(protection.require_conversation_resolution, true);
assert.equal(protection.allow_force_pushes, false);
assert.equal(protection.allow_deletions, false);
assert.equal(protection.bootstrap_reviews.minimum_approvals, 0);
assert.match(protection.bootstrap_reviews.promotion_gate, /minimum approvals to 1/);

const securityRules = new Set(contract.ci_contract.security_rules);
for (const rule of [
  'pull_request_jobs_receive_no_production_secrets',
  'fork_jobs_receive_no_repository_secrets',
  'self_hosted_production_runner_is_not_used_for_untrusted_pull_requests',
  'deployment_requires_a_separate_approved_workflow_and_main_commit'
]) assert.ok(securityRules.has(rule), `missing CI security rule: ${rule}`);

assert.equal(contract.access_matrix.length, 7);
for (const actor of contract.access_matrix) {
  assert.ok(actor.allow.length > 0 && actor.deny.length > 0, `incomplete access matrix: ${actor.actor}`);
}
const prRunner = contract.access_matrix.find((item) => item.actor === 'github_hosted_pr_runner');
assert.ok(prRunner.deny.includes('production_database_access'), 'CI_PRODUCTION_ACCESS_DENIED');
assert.ok(prRunner.deny.includes('production_deploy'), 'DEPLOYMENT_APPROVAL_REQUIRED');

const scenarios = new Map(contract.acceptance_scenarios.map((scenario) => [scenario.id, scenario]));
assert.equal(scenarios.size, 9);
assert.equal(scenarios.get('duplicate-runtime-path').error, 'DUPLICATE_WORKSPACE_PATH');
assert.equal(scenarios.get('frontend-imports-backend-internal').error, 'FORBIDDEN_DEPENDENCY');
assert.equal(scenarios.get('missing-required-check').error, 'REQUIRED_CHECK_MISSING');
assert.equal(scenarios.get('pull-request-secret-access').error, 'PR_SECRET_ACCESS_DENIED');
assert.equal(scenarios.get('ci-production-database-write').error, 'CI_PRODUCTION_ACCESS_DENIED');
assert.equal(scenarios.get('production-deploy-from-pr').error, 'DEPLOYMENT_APPROVAL_REQUIRED');

assert.equal(contract.rollback.runtime_action_required, false);
assert.equal(contract.rollback.database_action_required, false);

for (const heading of [
  'ساختار Monorepo',
  'مالکیت مسیر و داده مخزن',
  'قرارداد API، رویداد و جدول',
  'قرارداد CI و محافظت main',
  'ماتریس مجوز',
  'سناریوهای پذیرش',
  'نسخه‌بندی و Rollback'
]) assert.ok(markdown.includes(heading), `missing Markdown section: ${heading}`);

console.log(
  `Monorepo/CI contract valid: ${expectedRuntimes.size} runtimes, ${repositoryArtifacts.size} repository artifacts, ` +
  `${expectedChecks.size} required checks, ${contract.access_matrix.length} actors, 0 runtime APIs/events/tables added`
);

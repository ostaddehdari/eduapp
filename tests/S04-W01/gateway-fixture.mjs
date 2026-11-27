import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  applyAccessInvitations, applyAccessPolicy, applyIamMfa, applyIamSessions, applyOrganizationTree,
  applyManagementPanel, applyOnboarding, applyScopedOrgManagement, applySecurityAudit, applyTenantIsolation, applyTenantRegistry, runSqlBootstrap,
} from '../../packages/data/src/migrate.mjs';

const migrations = [
  applyTenantIsolation, applyIamSessions, applyAccessInvitations, applyAccessPolicy, applyIamMfa,
  applySecurityAudit, applyTenantRegistry, applyOrganizationTree, applyScopedOrgManagement, applyOnboarding,
];

export async function tenancyFixture(t, { includeOnboarding = false, includeManagement = false } = {}) {
  const configured = process.env.EDUAPP_S04_REGISTRY_PG_ADMIN_URL;
  assert(configured, 'Set EDUAPP_S04_REGISTRY_PG_ADMIN_URL for disposable PostgreSQL 17');
  const url = new URL(configured);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s04_registry_test');
  assert.equal(url.search + url.hash, '');
  url.pathname = '/postgres';
  const provisioner = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  await provisioner.connect();
  try {
    const exists = await provisioner.query("SELECT 1 FROM pg_database WHERE datname = 'eduapp_s04_gateway_test'");
    if (!exists.rowCount) await provisioner.query('CREATE DATABASE eduapp_s04_gateway_test');
  } finally {
    await provisioner.end();
  }
  url.pathname = '/eduapp_s04_gateway_test';
  const admin = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 3000 });
  await admin.connect();
  t.after(() => admin.end());
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);

  async function credentials(role) {
    const password = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    const scoped = new URL(url);
    scoped.username = role;
    scoped.password = password;
    return scoped.href;
  }
  const migrator = new pg.Client({ connectionString: await credentials('eduapp_schema_migrator') });
  await migrator.connect();
  try {
    for (const apply of migrations) await apply(migrator);
    if (includeManagement) await applyManagementPanel(migrator);
  } finally {
    await migrator.end();
  }
  const pools = {};
  for (const [name, role] of Object.entries({
    iamPool: 'eduapp_iam_api', peoplePool: 'eduapp_people_api', accessPool: 'eduapp_access_api',
    tenancyPool: 'eduapp_tenancy_api',
    ...(includeOnboarding ? { schoolPool: 'eduapp_school_api', sitesPool: 'eduapp_sites_api' } : {}),
    ...(includeManagement ? { billingPool: 'eduapp_billing_api' } : {}),
  })) {
    const pool = new pg.Pool({ connectionString: await credentials(role), max: 2, connectionTimeoutMillis: 3000 });
    t.after(() => pool.end());
    pools[name] = pool;
  }
  return { admin, pools };
}

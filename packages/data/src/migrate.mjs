import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const foundationVersion = '0001-tenant-isolation';
const sqlFile = (name) => new URL(`../migrations/${name}.sql`, import.meta.url);

async function inMigrationTransaction(client, operation) {
  await client.query('BEGIN');
  try {
    const result = await operation();
    const commit = await client.query('COMMIT');
    if (commit.command !== 'COMMIT') throw new Error('The migration transaction did not commit');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Migration transaction cleanup failed');
    }
    throw error;
  }
}

export async function runSqlBootstrap(client) {
  const sql = await readFile(sqlFile('bootstrap'), 'utf8');
  return inMigrationTransaction(client, async () => {
    await client.query('SET LOCAL search_path = pg_catalog');
    await client.query('SELECT pg_advisory_xact_lock(10302, 1)');
    await client.query(sql);
  });
}

async function applyMigration(client, migrationVersion, prerequisite) {
  const sql = await readFile(sqlFile(migrationVersion), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  return inMigrationTransaction(client, async () => {
    await client.query('SET LOCAL search_path = pg_catalog');
    await client.query('SELECT pg_advisory_xact_lock(10302, 1)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS eduapp_migrations.applied (
        version text PRIMARY KEY,
        sha256 text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const { rows: [existing] } = await client.query(
      'SELECT sha256 FROM eduapp_migrations.applied WHERE version = $1',
      [migrationVersion],
    );
    if (existing) {
      if (existing.sha256 !== checksum) throw new Error('Applied migration checksum differs');
      return false;
    }
    if (prerequisite) {
      const verified = await client.query(
        'SELECT 1 FROM eduapp_migrations.applied WHERE version = $1',
        [prerequisite],
      );
      if (verified.rowCount !== 1) throw new Error('Required foundation migration has not been applied');
    }
    await client.query(sql);
    await client.query(
      'INSERT INTO eduapp_migrations.applied (version, sha256) VALUES ($1, $2)',
      [migrationVersion, checksum],
    );
    return true;
  });
}

export function applyTenantIsolation(client) {
  return applyMigration(client, foundationVersion);
}

export function applyIamSessions(client) {
  return applyMigration(client, '0002-iam-sessions', foundationVersion);
}

export function applyAccessInvitations(client) {
  return applyMigration(client, '0003-access-invitations', foundationVersion);
}

export function applyAccessPolicy(client) {
  return applyMigration(client, '0004-access-policy', foundationVersion);
}

export function applyIamMfa(client) {
  return applyMigration(client, '0005-iam-mfa', '0002-iam-sessions');
}

export function applySecurityAudit(client) {
  return applyMigration(client, '0006-security-audit', foundationVersion);
}

export function applyTenantRegistry(client) {
  return applyMigration(client, '0007-tenant-registry', '0004-access-policy');
}

export function applyOrganizationTree(client) {
  return applyMigration(client, '0008-organization-tree', foundationVersion);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const connectionString = process.env.EDUAPP_DATABASE_URL;
  if (!connectionString || !['bootstrap', 'apply', 'apply-identity', 'apply-tenancy'].includes(mode)) {
    console.error('Set EDUAPP_DATABASE_URL and choose bootstrap, apply, apply-identity or apply-tenancy.');
    process.exitCode = 2;
  } else {
    try {
      const { Client } = await import('pg');
      const client = new Client({ connectionString });
      try {
        await client.connect();
        if (mode === 'bootstrap') {
          await runSqlBootstrap(client);
          console.log('EduApp database bootstrap complete');
        } else {
          const applied = await applyTenantIsolation(client);
          console.log(`Tenant isolation migration ${applied ? 'applied' : 'already applied'}`);
          if (['apply-identity', 'apply-tenancy'].includes(mode)) {
            await applyIamSessions(client);
            await applyAccessInvitations(client);
            await applyAccessPolicy(client);
            await applyIamMfa(client);
            await applySecurityAudit(client);
            console.log('Identity migrations verified');
          }
          if (mode === 'apply-tenancy') {
            await applyTenantRegistry(client);
            await applyOrganizationTree(client);
            console.log('Tenancy migrations verified');
          }
        }
      } finally {
        await client.end();
      }
    } catch (error) {
      console.error(`EduApp database ${mode} failed`, typeof error.code === 'string' ? error.code : '');
      process.exitCode = 1;
    }
  }
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const migrationVersion = '0001-tenant-isolation';
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

export async function applyTenantIsolation(client) {
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
    await client.query(sql);
    await client.query(
      'INSERT INTO eduapp_migrations.applied (version, sha256) VALUES ($1, $2)',
      [migrationVersion, checksum],
    );
    return true;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const connectionString = process.env.EDUAPP_DATABASE_URL;
  if (!connectionString || (mode !== 'bootstrap' && mode !== 'apply')) {
    console.error('Set EDUAPP_DATABASE_URL and choose bootstrap or apply.');
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

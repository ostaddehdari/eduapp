import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { applyTenantIsolation, runSqlBootstrap } from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';

const adminUrl = process.env.EDUAPP_PG_ADMIN_URL;
const contractPath = new URL('../../docs/contracts/S02-W03.json', import.meta.url);
const tenancy = 'eduapp_tenancy_api';
const billing = 'eduapp_billing_api';
const sites = 'eduapp_sites_api';
const platform = 'eduapp_platform_worker';
const migrator = 'eduapp_schema_migrator';
const poolError = (sqlState) => ({ code: sqlState });

test('PostgreSQL tenant isolation and transactional data acceptance', { timeout: 30_000 }, async (t) => {
  assert(adminUrl, 'Set EDUAPP_PG_ADMIN_URL for a disposable PostgreSQL 17 fixture');
  const url = new URL(adminUrl);
  assert(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'The test fixture must be local');
  assert.equal(url.pathname, '/eduapp_w03_test', 'Use the dedicated W03 database fixture');
  assert.equal(url.search, '', 'Fixture URLs must identify the local test database directly');

  const modulePath = process.env.EDUAPP_PG_MODULE;
  const driver = await import(modulePath ? pathToFileURL(modulePath).href : 'pg');
  const { Client, Pool } = driver.default ?? driver;
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  const admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 2_000 });
  await admin.connect();
  t.after(() => admin.end());
  const dbVersion = await admin.query('SHOW server_version_num');
  assert.match(dbVersion.rows[0].server_version_num, /^17\d{4}$/);

  await runSqlBootstrap(admin);
  await runSqlBootstrap(admin);
  const logins = new Map();
  for (const role of [tenancy, billing, sites, platform, migrator]) {
    // The identifiers above are fixed, and the ephemeral secret is generated as hex.
    const password = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    const credentials = new URL(url);
    credentials.username = role;
    credentials.password = password;
    logins.set(role, credentials.href);
  }

  const migrationClient = new Client({ connectionString: logins.get(migrator) });
  try {
    await migrationClient.connect();
    const receiptCatalog = await migrationClient.query(
      "SELECT to_regclass('eduapp_migrations.applied') IS NOT NULL AS present",
    );
    const wasApplied = receiptCatalog.rows[0].present && (await migrationClient.query(
      "SELECT 1 FROM eduapp_migrations.applied WHERE version = '0001-tenant-isolation'",
    )).rowCount === 1;
    assert.equal(await applyTenantIsolation(migrationClient), !wasApplied);
    assert.equal(await applyTenantIsolation(migrationClient), false);
  } finally {
    await migrationClient.end();
  }

  const makePool = (role) => {
    const pool = new Pool({ connectionString: logins.get(role), max: 1, connectionTimeoutMillis: 2_000 });
    t.after(() => pool.end());
    return pool;
  };
  const tenantPool = makePool(tenancy);
  const tenantRun = createTenantTransactions(tenantPool).run;
  const billingRun = createTenantTransactions(makePool(billing)).run;
  const sitesRun = createTenantTransactions(makePool(sites)).run;
  const platformRun = createTenantTransactions(makePool(platform)).run;
  const a = { id: randomUUID(), unit: randomUUID(), site: randomUUID() };
  const b = { id: randomUUID(), unit: randomUUID(), site: randomUUID() };
  for (const tenant of [a, b]) {
    await tenantRun(tenant.id, async (db) => {
      await db.query('INSERT INTO tenancy_organization.tenants (id, slug, status) VALUES ($1, $2, $3)',
        [tenant.id, tenant.id, 'active']);
      await db.query('INSERT INTO tenancy_organization.org_units (tenant_id, id, kind, code) VALUES ($1, $2, $3, $4)',
        [tenant.id, tenant.unit, 'school', tenant.unit]);
    });
    await sitesRun(tenant.id, (db) => db.query(
      'INSERT INTO sites_content.sites (tenant_id, id, org_unit_id) VALUES ($1, $2, $3)',
      [tenant.id, tenant.site, tenant.unit],
    ));
  }

  await t.test('schema follows the versioned table, index and role contract', async () => {
    const relations = await admin.query(`
      SELECT n.nspname AS schema, c.relname AS table, c.relrowsecurity AS rls,
             c.relforcerowsecurity AS force_rls, pg_get_userbyid(c.relowner) AS schema_owner,
             EXISTS (
               SELECT FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                 AND a.atttypid = 'uuid'::regtype AND a.attnotnull
             ) AS required_tenant_id
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ANY ($1) AND c.relkind = 'r'
    `, [[...new Set(contract.ownership.map((owner) => owner.schema))]]);
    const tableLookup = new Map(relations.rows.map((row) => [`${row.schema}.${row.table}`, row]));
    const declaredTables = contract.ownership.flatMap((owner) => owner.tables);
    assert.equal(tableLookup.size, declaredTables.length);
    const policyRows = await admin.query(`
      SELECT schemaname, tablename, qual, with_check FROM pg_policies
      WHERE policyname = 'tenant_guard' AND permissive = 'RESTRICTIVE'
    `);
    const policies = new Map(policyRows.rows.map((row) => [`${row.schemaname}.${row.tablename}`, row]));
    const roleRows = await admin.query(`
      SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb,
        EXISTS (SELECT FROM pg_auth_members WHERE member = pg_roles.oid) AS has_membership
      FROM pg_roles WHERE rolname LIKE 'eduapp_%'
    `);
    const roleByName = new Map(roleRows.rows.map((row) => [row.rolname, row]));
    for (const { owner, schema, tables, write_runtime: runtime } of contract.ownership) {
      const ownerRole = `eduapp_${schema}_owner`;
      assert.equal(roleByName.get(ownerRole).rolcanlogin, false);
      const roles = runtime === 'worker' ? [`eduapp_${owner}_worker`] : [`eduapp_${owner}_api`];
      if (runtime === 'api_or_worker_via_owned_service') roles.push(`eduapp_${owner}_worker`);
      for (const role of roles) {
        const attrs = roleByName.get(role);
        assert(attrs.rolcanlogin);
        assert.equal(attrs.rolsuper || attrs.rolbypassrls || attrs.rolcreaterole ||
          attrs.rolcreatedb || attrs.has_membership, false);
        const { rows: [scope] } = await admin.query(
          "SELECT has_schema_privilege($1, $2, 'CREATE') AS create_allowed",
          [role, schema],
        );
        assert.equal(scope.create_allowed, false);
        const grants = await admin.query(`
          SELECT n.nspname || '.' || c.relname AS relation,
                 has_table_privilege($1, c.oid, 'TRUNCATE') AS can_truncate,
                 has_table_privilege($1, c.oid, 'UPDATE,DELETE') AS can_modify
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ANY ($2) AND c.relkind = 'r'
            AND has_table_privilege($1, c.oid, 'SELECT')
        `, [role, [...new Set(contract.ownership.map((entry) => entry.schema))]]);
        assert.deepEqual(grants.rows.map((grant) => grant.relation).sort(),
          tables.map((table) => `${schema}.${table.name}`).sort());
        for (const grant of grants.rows) {
          assert.equal(grant.can_truncate, false);
          const table = tables.find((entry) => grant.relation === `${schema}.${entry.name}`);
          if (table.append_only || table.scope === 'shared_catalog') assert.equal(grant.can_modify, false);
        }
      }
      for (const { name, scope, tenant_key: key } of tables) {
        const relation = tableLookup.get(`${schema}.${name}`);
        assert.equal(relation.schema_owner, ownerRole);
        assert.equal(relation.required_tenant_id, scope === 'tenant');
        assert.equal(relation.rls, key !== null);
        assert.equal(relation.force_rls, key !== null);
        if (key) {
          const policy = policies.get(`${schema}.${name}`);
          assert.match(policy.qual, new RegExp(`^\\(${key} = .*app\\.tenant_id`));
          assert.equal(policy.with_check, policy.qual);
        }
      }
    }

    const indexes = await admin.query(`
      SELECT tab.relname AS table, indexes.indisunique AS is_unique,
        pg_get_expr(indexes.indpred, indexes.indrelid) AS predicate,
        ARRAY(SELECT a.attname::text FROM unnest(indexes.indkey) WITH ORDINALITY AS key(attnum, position)
          JOIN pg_attribute a ON a.attrelid = tab.oid AND a.attnum = key.attnum
          ORDER BY key.position) AS columns
      FROM pg_index indexes JOIN pg_class tab ON tab.oid = indexes.indrelid
      JOIN pg_namespace n ON n.oid = tab.relnamespace
      WHERE n.nspname = ANY ($1)
    `, [[...new Set(contract.ownership.map((owner) => owner.schema))]]);
    for (const expected of contract.indexes) {
      assert(indexes.rows.some((row) => row.table === expected.table && row.is_unique === expected.unique &&
        row.columns.join(',') === expected.columns.join(',') &&
        (expected.predicate ? row.predicate?.includes(expected.predicate) : row.predicate === null)),
      `Missing approved index on ${expected.table} (${expected.columns.join(', ')})`);
    }
  });

  await t.test('runtime isolation, owned data and composite references', async () => {
    await tenantRun(a.id, async (db) => {
      assert.deepEqual((await db.query('SELECT id FROM tenancy_organization.org_units')).rows, [{ id: a.unit }]);
      assert.equal((await db.query('UPDATE tenancy_organization.org_units SET code = $1 WHERE id = $2',
        ['confirmed-local', a.unit])).rowCount, 1);
      assert.equal((await db.query('UPDATE tenancy_organization.org_units SET code = $1 WHERE id = $2',
        ['forbidden', b.unit])).rowCount, 0);
      assert.equal((await db.query('DELETE FROM tenancy_organization.org_units WHERE id = $1', [b.unit])).rowCount, 0);
    });
    await assert.rejects(tenantRun(a.id, (db) => db.query(
      "INSERT INTO tenancy_organization.org_units (tenant_id, kind, code) VALUES ($1, 'school', 'foreign')",
      [b.id],
    )), poolError('42501'));
    await assert.rejects(tenantRun(a.id, (db) => db.query(
      'UPDATE tenancy_organization.org_units SET tenant_id = $1 WHERE id = $2', [b.id, a.unit],
    )), poolError('42501'));
    await assert.rejects(tenantRun(a.id, (db) => db.query(
      "INSERT INTO tenancy_organization.org_units (tenant_id, parent_id, kind, code) VALUES ($1, $2, 'class', 'cross-parent')",
      [a.id, b.unit],
    )), poolError('23503'));
    await tenantRun(a.id, (db) => db.query(
      "INSERT INTO tenancy_organization.org_units (tenant_id, parent_id, kind, code) VALUES ($1, $2, 'class', 'own-parent')",
      [a.id, a.unit],
    ));
    await assert.rejects(tenantRun(a.id, (db) => db.query('SELECT id FROM commercial_billing.plans')), poolError('42501'));
    await assert.rejects(tenantRun(a.id, (db) => db.query(
      "INSERT INTO commercial_billing.plans (code) VALUES ('foreign-owner')",
    )), poolError('42501'));
    assert.deepEqual((await tenantRun(b.id, (db) => db.query('SELECT id, code FROM tenancy_organization.org_units'))).rows,
      [{ id: b.unit, code: b.unit }]);
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE eduapp_tenancy_organization_owner');
      assert.equal((await admin.query('SELECT id FROM tenancy_organization.org_units')).rowCount, 0);
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  await t.test('one physical connection rebinds after commit and rollback', async () => {
    const first = await tenantRun(a.id, async (db) => (await db.query('SELECT pg_backend_pid() AS pid')).rows[0]);
    await assert.rejects(tenantRun(a.id, async (db) => {
      assert.equal((await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, first.pid);
      await db.query('UPDATE tenancy_organization.org_units SET code = $1 WHERE id = $2', ['rolled-back', a.unit]);
      throw new Error('fixture rollback');
    }), /fixture rollback/);
    const unbound = await tenantPool.query(`
      SELECT pg_backend_pid() AS pid, NULLIF(current_setting('app.tenant_id', true), '') AS scope,
        (SELECT count(*)::int FROM tenancy_organization.org_units) AS rows
    `);
    assert.deepEqual(unbound.rows, [{ pid: first.pid, scope: null, rows: 0 }]);
    const other = await tenantRun(b.id, (db) => db.query('SELECT pg_backend_pid() AS pid, id FROM tenancy_organization.org_units'));
    assert.deepEqual(other.rows, [{ pid: first.pid, id: b.unit }]);
    const rolledBack = await tenantRun(a.id, (db) => db.query(
      'SELECT code FROM tenancy_organization.org_units WHERE id = $1', [a.unit],
    ));
    assert.deepEqual(rolledBack.rows, [{ code: 'confirmed-local' }]);
    await assert.rejects(tenantRun('', async () => {}), /authorized tenant UUID/);
    await assert.rejects(tenantPool.query(
      "INSERT INTO tenancy_organization.org_units (tenant_id, kind, code) VALUES ($1, 'school', 'unbound')", [a.id],
    ), poolError('42501'));
  });

  await t.test('uncertain cleanup discards the actual connection', async () => {
    let pid;
    const run = createTenantTransactions({
      async connect() {
        const leased = await tenantPool.connect();
        return {
          query(text, values) {
            if (text === 'ROLLBACK') throw new Error('fixture rollback transport failure');
            return leased.query(text, values);
          },
          release(discard) { leased.release(discard); },
        };
      },
    }).run;
    await assert.rejects(run(a.id, async (db) => {
      pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await db.query('UPDATE tenancy_organization.org_units SET code = $1 WHERE id = $2', ['discarded', a.unit]);
      throw new Error('fixture work failure');
    }), /Tenant transaction cleanup failed/);
    const replacement = await tenantRun(a.id, (db) => db.query(
      'SELECT pg_backend_pid() AS pid, code FROM tenancy_organization.org_units WHERE id = $1', [a.unit],
    ));
    assert.notEqual(replacement.rows[0].pid, pid);
    assert.equal(replacement.rows[0].code, 'confirmed-local');
  });

  await t.test('global uniqueness and tenant-scoped retry keys are enforced', async () => {
    const host = `${randomUUID()}.example.test`;
    const hostInsert = (tenant) => sitesRun(tenant.id, (db) => db.query(
      "INSERT INTO sites_content.domains (tenant_id, site_id, host_normalized, proof_status) VALUES ($1, $2, $3, 'verified')",
      [tenant.id, tenant.site, host],
    ));
    await hostInsert(a);
    await assert.rejects(hostInsert(b), poolError('23505'));

    const stableKey = randomUUID();
    const insertReceipt = (tenant) => billingRun(tenant.id, (db) => db.query(
      "INSERT INTO commercial_billing.provider_events (provider, provider_event_id, payload_hash) VALUES ('fixture', $1, 'fixture')",
      [stableKey],
    ));
    await insertReceipt(a);
    await assert.rejects(insertReceipt(b), poolError('23505'));

    const plans = await admin.query('INSERT INTO commercial_billing.plans (code) VALUES ($1) RETURNING id', [stableKey]);
    const version = (await admin.query(`
      INSERT INTO commercial_billing.plan_versions (plan_id, price_minor, currency, effective_at)
      VALUES ($1, 1, 'IRR', now()) RETURNING id
    `, [plans.rows[0].id])).rows[0].id;
    for (const tenant of [a, b]) {
      await billingRun(tenant.id, async (db) => {
        const subscription = (await db.query(
          "INSERT INTO commercial_billing.subscriptions (tenant_id, plan_version_id, status) VALUES ($1, $2, 'active') RETURNING id",
          [tenant.id, version],
        )).rows[0].id;
        const invoice = (await db.query(`
          INSERT INTO commercial_billing.invoices (tenant_id, subscription_id, amount_minor, currency, status)
          VALUES ($1, $2, 1, 'IRR', 'open') RETURNING id
        `, [tenant.id, subscription])).rows[0].id;
        const attemptSql = `
          INSERT INTO commercial_billing.payment_attempts (tenant_id, invoice_id, idempotency_key, request_hash, status)
          VALUES ($1, $2, $3, 'fixture', 'pending')
          ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        `;
        assert.equal((await db.query(attemptSql, [tenant.id, invoice, stableKey])).rowCount, 1);
        assert.equal((await db.query(attemptSql, [tenant.id, invoice, stableKey])).rowCount, 0);
      });
    }
  });

  await t.test('aggregate and outbox roll back together and replay cannot repeat an effect', async () => {
    const rejected = randomUUID();
    const durable = randomUUID();
    const topic = 'tenancy.org_unit_changed.v1';
    const append = (db, id, type = topic) => db.query(
      "SELECT platform_audit_jobs.append_outbox($1, $2, '{}'::jsonb)", [id, type],
    );
    await assert.rejects(tenantRun(a.id, (db) => append(db, rejected, 'attendance.confirmed.v1')), poolError('42501'));
    await assert.rejects(tenantRun(a.id, async (db) => {
      await db.query('UPDATE tenancy_organization.org_units SET code = $1 WHERE id = $2', ['outbox-rollback', a.unit]);
      await append(db, rejected);
      throw new Error('fixture outbox abort');
    }), /fixture outbox abort/);
    assert.equal((await platformRun(a.id, (db) => db.query(
      'SELECT id FROM platform_audit_jobs.outbox_events WHERE id = $1', [rejected],
    ))).rowCount, 0);
    const aggregate = (await tenantRun(a.id, (db) => db.query(
      'SELECT code FROM tenancy_organization.org_units WHERE id = $1', [a.unit],
    ))).rows;
    assert.deepEqual(aggregate, [{ code: 'confirmed-local' }]);
    await tenantRun(a.id, (db) => append(db, durable));
    assert.equal((await platformRun(b.id, (db) => db.query(
      'SELECT id FROM platform_audit_jobs.outbox_events WHERE id = $1', [durable],
    ))).rowCount, 0);
    const consumer = 'fixture-consumer';
    const replay = () => platformRun(a.id, async (db) => {
      const accepted = await db.query(`
        INSERT INTO platform_audit_jobs.inbox_dedup (tenant_id, consumer, event_id) VALUES ($1, $2, $3)
        ON CONFLICT (consumer, event_id) DO NOTHING
      `, [a.id, consumer, durable]);
      if (accepted.rowCount === 1) {
        await db.query(
          "INSERT INTO platform_audit_jobs.audit_events (tenant_id, action, resource_ref) VALUES ($1, 'fixture', $2)",
          [a.id, durable],
        );
      }
      return accepted.rowCount;
    });
    assert.equal(await replay(), 1);
    assert.equal(await replay(), 0);
    assert.equal((await platformRun(a.id, (db) => db.query(
      'SELECT id FROM platform_audit_jobs.audit_events WHERE resource_ref = $1', [durable],
    ))).rowCount, 1);
    await assert.rejects(platformRun(b.id, (db) => db.query(
      'INSERT INTO platform_audit_jobs.inbox_dedup (tenant_id, consumer, event_id) VALUES ($1, $2, $3)',
      [b.id, consumer, durable],
    )), poolError('23505'));
  });
});

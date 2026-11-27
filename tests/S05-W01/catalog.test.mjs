import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import pg from 'pg';
import { createGateway } from '../../apps/api-gateway/src/gateway.mjs';
import { createPlanCatalog, CatalogError } from '../../apps/commerce-service/src/catalog.mjs';
import { createCommerceGatewayOptions } from '../../apps/commerce-service/src/routes.mjs';
import { applyPlanCatalog, applyTenantIsolation, runSqlBootstrap } from '../../packages/data/src/migrate.mjs';
import { createTenantTransactions } from '../../packages/data/src/tenant-transactions.mjs';

test('catalog versions, discount quotes and tenant boundaries on PostgreSQL 17', { timeout: 40_000 }, async t => {
  const source = process.env.EDUAPP_S05_CATALOG_PG_ADMIN_URL;
  assert(source, 'Set EDUAPP_S05_CATALOG_PG_ADMIN_URL');
  const url = new URL(source);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/eduapp_s05_catalog_test');
  assert.equal(url.search, '');
  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = '/postgres';
  const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
  await maintenance.connect();
  t.after(() => maintenance.end());
  if (!(await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', ['eduapp_s05_catalog_test'])).rowCount) {
    await maintenance.query('CREATE DATABASE eduapp_s05_catalog_test');
  }
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  t.after(() => admin.end());
  assert.match((await admin.query('SHOW server_version_num')).rows[0].server_version_num, /^17\d{4}$/);
  await runSqlBootstrap(admin);
  const password = randomBytes(24).toString('hex');
  await admin.query(`ALTER ROLE eduapp_billing_api PASSWORD '${password}'`);
  const roleUrl = new URL(url);
  roleUrl.username = 'eduapp_billing_api';
  roleUrl.password = password;
  const migratorUrl = new URL(url);
  const migratorPassword = randomBytes(24).toString('hex');
  await admin.query(`ALTER ROLE eduapp_schema_migrator PASSWORD '${migratorPassword}'`);
  migratorUrl.username = 'eduapp_schema_migrator';
  migratorUrl.password = migratorPassword;
  const migrator = new pg.Client({ connectionString: migratorUrl.href });
  await migrator.connect();
  t.after(() => migrator.end());
  await applyTenantIsolation(migrator);
  assert.equal(await applyPlanCatalog(migrator), true);
  assert.equal(await applyPlanCatalog(migrator), false);
  const pool = new pg.Pool({ connectionString: roleUrl.href, max: 4 });
  t.after(() => pool.end());
  const clock = () => new Date('2026-11-27T12:00:00Z');
  const owner = { actor: randomUUID() };
  const catalog = createPlanCatalog({
    pool, authorizePublish: ({ identity }) => identity === owner, now: clock,
  });
  const offer = {
    code: 'school_plus', expectedVersion: 0, priceMinor: 100_000, currency: 'IRR',
    modules: ['school', 'attendance'], quotas: { seats: 100, branches: 4 },
    trialDays: 14, termDays: 365,
  };
  await t.test('publisher authority and immutable revisions preserve original price and quota', async () => {
    await assert.rejects(catalog.publish({}, offer), { message: 'FORBIDDEN' });
    const first = await catalog.publish(owner, offer);
    assert.equal(first.version, 1);
    assert.equal(first.priceMinor, '100000');
    assert.deepEqual(first.quotas, offer.quotas);
    const results = await Promise.allSettled([
      catalog.publish(owner, { ...offer, expectedVersion: 1, priceMinor: 200_000 }),
      catalog.publish(owner, { ...offer, expectedVersion: 1, priceMinor: 300_000 }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find(result => result.status === 'rejected').reason.message, 'CONFLICT');
    const listing = await catalog.list({ page: { limit: 1 } });
    assert.equal(listing.data.length, 1);
    assert(listing.nextPosition);
    const next = await catalog.list({ page: { limit: 1, position: listing.nextPosition } });
    assert.equal(next.data.length, 1);
    assert.deepEqual(new Set([listing.data[0].priceMinor, next.data[0].priceMinor]), new Set(['100000',
      String(results.find(result => result.status === 'fulfilled').value.priceMinor)]));
    await assert.rejects(pool.query('UPDATE commercial_billing.plan_versions SET price_minor = 1'), { code: '42501' });
    await assert.rejects(pool.query('DELETE FROM commercial_billing.plan_versions'), { code: '42501' });
    const server = createServer(createGateway({ routes: createCommerceGatewayOptions({
      pool, authorizePublish: () => false, now: clock,
    }).routes }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/v1/plans?limit=1');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.length, 1);
  });

  await t.test('discount and trial apply to verified tenant quote without rewriting subscriptions', async () => {
    const versions = await catalog.list({ page: { limit: 5 } });
    const first = versions.data.find(item => item.version === 1);
    await catalog.publishDiscount(owner, {
      code: 'SAVE20', planId: first.planId, percentage: 20,
      validFrom: '2026-11-26T00:00:00Z', validTo: '2026-12-01T00:00:00Z',
    });
    const a = randomUUID(), b = randomUUID();
    const principal = tenantId => ({ tenantId, scope: tenantId });
    const original = await catalog.quote({ identity: principal(a), planVersionId: first.id, discountCode: 'SAVE20' });
    assert.equal(original.payableMinor, '80000');
    assert.equal(original.trialDays, 14);
    assert.equal(original.renewal, false);
    const tx = createTenantTransactions(pool);
    await tx.run(a, db => db.query(`
      INSERT INTO commercial_billing.subscriptions(tenant_id, plan_version_id, status) VALUES ($1,$2,'active')
    `, [a, first.id]));
    const renewal = await catalog.quote({ identity: principal(a), planVersionId: first.id });
    assert.equal(renewal.trialDays, 0);
    assert.equal(renewal.renewal, true);
    assert.equal((await catalog.quote({ identity: principal(b), planVersionId: first.id })).trialDays, 14);
    const foreignRows = await tx.run(b, db => db.query(
      'SELECT id FROM commercial_billing.subscriptions WHERE tenant_id = $1', [a]));
    assert.equal(foreignRows.rowCount, 0);
    assert.equal((await admin.query('SELECT plan_version_id FROM commercial_billing.subscriptions WHERE tenant_id = $1',
      [a])).rows[0].plan_version_id, first.id);
    await assert.rejects(catalog.quote({ identity: { tenantId: b, scope: a }, planVersionId: first.id }), CatalogError);
    await assert.rejects(catalog.quote({ identity: principal(a), planVersionId: first.id,
      discountCode: 'INVALID' }), { message: 'VALIDATION_FAILED' });
  });
});

import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { consumeNext } from '../../apps/worker/event-delivery/delivery.mjs';
import { consumerNames } from '../../apps/worker/event-delivery/event-contract.mjs';
import { createPostgresEventStore } from '../../apps/worker/event-delivery/postgres-store.mjs';
import { localFixtureUrl } from './service-url.mjs';

const databaseUrl = process.env.EDUAPP_W04_PG_ADMIN_URL;
const brokerUrl = process.env.EDUAPP_TEST_AMQP_URL;

test('PostgreSQL and RabbitMQ restore a pending financial event without double effect', {
  skip: !databaseUrl || !brokerUrl, timeout: 40_000,
}, async (t) => {
  const adminUrl = localFixtureUrl(databaseUrl, ['postgres:', 'postgresql:']);
  const amqpUrl = localFixtureUrl(brokerUrl, ['amqp:', 'amqps:']).href;
  assert.equal(adminUrl.pathname, '/eduapp_w04_test', 'Use the dedicated disposable database');
  const require = createRequire(new URL('../../apps/worker/package.json', import.meta.url));
  const { Client, Pool } = require('pg');
  const amqp = require('amqplib');
  const [{ runSqlBootstrap, applyTenantIsolation }, { createTenantTransactions }, { openRabbitMqBroker }] = await Promise.all([
    import('../../packages/data/src/migrate.mjs'),
    import('../../packages/data/src/tenant-transactions.mjs'),
    import('../../apps/worker/event-delivery/rabbitmq.mjs'),
  ]);

  const setupUrl = new URL(adminUrl);
  setupUrl.pathname = '/postgres';
  const setup = new Client({ connectionString: setupUrl.href });
  await setup.connect();
  try {
    const exists = await setup.query('SELECT 1 FROM pg_database WHERE datname = $1', ['eduapp_w04_test']);
    if (!exists.rowCount) await setup.query('CREATE DATABASE eduapp_w04_test');
  } finally {
    await setup.end();
  }

  const admin = new Client({ connectionString: adminUrl.href });
  await admin.connect();
  const syntheticSchema = `w04_${randomBytes(8).toString('hex')}`;
  const amountTable = `${syntheticSchema}.financial_effect`;
  const namespace = `eduapp.integrated.${randomUUID()}`;
  const pools = [];
  let broker;
  let observer;
  let observerChannel;
  t.after(async () => {
    if (broker) await broker.close();
    if (observerChannel) {
      for (const name of consumerNames) {
        await observerChannel.deleteQueue(`${namespace}.${name}`);
        await observerChannel.deleteQueue(`${namespace}.${name}.dlq`);
      }
    }
    if (observer) await observer.close();
    await Promise.all(pools.map(pool => pool.end()));
    await admin.query(`DROP SCHEMA IF EXISTS ${syntheticSchema} CASCADE`);
    await admin.end();
  });

  await runSqlBootstrap(admin);
  async function fixtureLogin(role) {
    const password = randomBytes(24).toString('hex');
    await admin.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    const url = new URL(adminUrl);
    url.username = role;
    url.password = password;
    return url.href;
  }
  const migrator = new Client({ connectionString: await fixtureLogin('eduapp_schema_migrator') });
  await migrator.connect();
  try {
    await applyTenantIsolation(migrator);
  } finally {
    await migrator.end();
  }

  async function transactionsAs(role) {
    const pool = new Pool({ connectionString: await fixtureLogin(role), max: 1 });
    pools.push(pool);
    return createTenantTransactions(pool);
  }
  const billing = await transactionsAs('eduapp_billing_api');
  const store = createPostgresEventStore(await transactionsAs('eduapp_platform_worker'));
  const tenants = [randomUUID(), randomUUID()];
  for (const tenant of tenants) {
    await admin.query('INSERT INTO tenancy_organization.tenants (id, slug, status) VALUES ($1, $2, $3)',
      [tenant, `test-${tenant}`, 'active']);
  }
  const plan = randomUUID();
  const planVersion = randomUUID();
  await admin.query('INSERT INTO commercial_billing.plans (id, code) VALUES ($1, $2)', [plan, `test-${plan}`]);
  await admin.query(`INSERT INTO commercial_billing.plan_versions (id, plan_id, price_minor, currency, effective_at)
    VALUES ($1, $2, 200, 'IRR', now())`, [planVersion, plan]);
  await admin.query(`CREATE SCHEMA ${syntheticSchema};
    CREATE TABLE ${amountTable} (tenant_id uuid NOT NULL, event_id uuid NOT NULL, amount_minor bigint NOT NULL);
    GRANT USAGE ON SCHEMA ${syntheticSchema} TO eduapp_platform_worker;
    GRANT INSERT ON ${amountTable} TO eduapp_platform_worker`);

  const type = 'billing.subscription_activated.v1';
  function activate(tenant, subscription, id, abort = false) {
    return billing.run(tenant, async (connection) => {
      await connection.query(`INSERT INTO commercial_billing.subscriptions (tenant_id, id, plan_version_id, status)
        VALUES ($1, $2, $3, 'active')`, [tenant, subscription, planVersion]);
      await connection.query('SELECT platform_audit_jobs.append_outbox($1::uuid, $2::text, $3::jsonb)',
        [id, type, { subscription_id: subscription, activation_revision: 1 }]);
      if (abort) throw new Error('fixture_rollback');
    });
  }

  const rolledBackId = randomUUID();
  const rolledBackSubscription = randomUUID();
  await assert.rejects(activate(tenants[0], rolledBackSubscription, rolledBackId, true), /fixture_rollback/);
  assert.equal((await admin.query('SELECT 1 FROM platform_audit_jobs.outbox_events WHERE id = $1', [rolledBackId])).rowCount, 0);
  assert.equal((await admin.query('SELECT 1 FROM commercial_billing.subscriptions WHERE id = $1', [rolledBackSubscription])).rowCount, 0);

  const ids = [randomUUID(), randomUUID()];
  for (const [index, tenant] of tenants.entries()) await activate(tenant, randomUUID(), ids[index]);
  broker = await openRabbitMqBroker({ url: amqpUrl, namespace });
  observer = await amqp.connect(amqpUrl);
  observerChannel = await observer.createChannel();
  await broker.close();
  await assert.rejects(store.publishNext(tenants[0], broker.publish));
  const pending = () => admin.query('SELECT 1 FROM platform_audit_jobs.outbox_events WHERE id = ANY($1::uuid[]) AND published_at IS NULL', [ids]);
  assert.equal((await pending()).rowCount, 2);
  broker = await openRabbitMqBroker({ url: amqpUrl, namespace });
  for (const tenant of tenants) assert.equal(await store.publishNext(tenant, broker.publish), true);
  assert.equal((await pending()).rowCount, 0);

  const consumer = 'tenancy_organization';
  const unsettled = await broker.receive(consumer);
  const first = JSON.parse(unsettled.body);
  assert.equal(first.id, ids[0]);
  await broker.close();
  broker = await openRabbitMqBroker({ url: amqpUrl, namespace });
  let failFirstEffect = true;
  const deliver = () => consumeNext({
    store, broker, consumer, allowedTenants: new Set(tenants),
    async handle(event, connection) {
      await connection.query(`INSERT INTO ${amountTable} (tenant_id, event_id, amount_minor) VALUES ($1, $2, 200)`,
        [event.tenantId, event.id]);
      if (event.id === ids[0] && failFirstEffect) {
        failFirstEffect = false;
        throw new Error('fixture_handler_transaction_failed');
      }
    },
  });
  assert.equal(await deliver(), true);
  assert.equal((await admin.query(`SELECT 1 FROM ${amountTable} WHERE event_id = $1`, [first.id])).rowCount, 0);
  assert.equal((await admin.query('SELECT 1 FROM platform_audit_jobs.inbox_dedup WHERE event_id = $1', [first.id])).rowCount, 0);
  assert.equal(await deliver(), true);
  assert.equal(await deliver(), true);
  await broker.publish(first);
  assert.equal(await deliver(), true);
  await broker.publish({ ...first, tenantId: tenants[1] });
  assert.equal(await deliver(), true);
  assert.equal(await deliver(), false);

  const { rows } = await admin.query(`SELECT tenant_id, event_id FROM ${amountTable} ORDER BY event_id`);
  assert.deepEqual(rows.map(row => row.event_id).sort(), [...ids].sort());
  assert.deepEqual(rows.map(row => row.tenant_id).sort(), [...tenants].sort());
  const deadLetter = await observerChannel.get(`${namespace}.${consumer}.dlq`, { noAck: true });
  assert.deepEqual(JSON.parse(deadLetter.content), {
    id: first.id, tenantId: tenants[1], type, attempt: 1, code: 'tenant_conflict',
  });
});

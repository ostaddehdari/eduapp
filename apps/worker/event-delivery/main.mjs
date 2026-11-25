import console from 'node:console';
import process from 'node:process';
import { createTenantTransactions } from '@eduapp/data/tenant-transactions';
import pg from 'pg';
import { runDelivery } from './delivery.mjs';
import { createPostgresEventStore } from './postgres-store.mjs';
import { openRabbitMqBroker } from './rabbitmq.mjs';

const { EDUAPP_PLATFORM_PG_URL, EDUAPP_AMQP_URL, EDUAPP_EVENT_TENANTS } = process.env;
if (!EDUAPP_PLATFORM_PG_URL || !EDUAPP_AMQP_URL || !EDUAPP_EVENT_TENANTS) {
  console.error('event_delivery_configuration_missing');
  process.exitCode = 2;
} else {
  const stop = new globalThis.AbortController();
  const shutdown = () => stop.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const pool = new pg.Pool({
    connectionString: EDUAPP_PLATFORM_PG_URL, max: 2, connectionTimeoutMillis: 5_000,
    statement_timeout: 5_000, idle_in_transaction_session_timeout: 15_000,
  });
  pool.on('error', () => console.warn('event_delivery_pool_unavailable'));
  try {
    await runDelivery({
      store: createPostgresEventStore(createTenantTransactions(pool)),
      openBroker: () => openRabbitMqBroker({ url: EDUAPP_AMQP_URL }),
      tenants: EDUAPP_EVENT_TENANTS.split(',').map(tenant => tenant.trim()),
      signal: stop.signal,
      onUnavailable: () => console.warn('event_delivery_temporarily_unavailable'),
      handlers: {
        platform_audit_jobs: async (event, connection) => {
          await connection.query(
            `INSERT INTO platform_audit_jobs.audit_events (id, tenant_id, action, resource_ref, occurred_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [event.id, event.tenantId, event.type, event.id, event.occurredAt],
          );
        },
      },
    });
  } catch {
    console.error('event_delivery_stopped');
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await pool.end();
  }
}

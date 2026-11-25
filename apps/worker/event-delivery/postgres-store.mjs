import { InvalidDelivery, validateEvent } from './event-contract.mjs';

export function createPostgresEventStore(transactions) {
  return {
    async publishNext(tenantId, publish) {
      return transactions.run(tenantId, async (connection) => {
        const { rows } = await connection.query(
          `SELECT id, tenant_id, event_type, payload, occurred_at
             FROM platform_audit_jobs.outbox_events
            WHERE tenant_id = $1 AND published_at IS NULL
            ORDER BY occurred_at, id
            LIMIT 1 FOR UPDATE SKIP LOCKED`, [tenantId],
        );
        const row = rows[0];
        if (!row) return false;
        const event = validateEvent({
          id: row.id, tenantId: row.tenant_id, type: row.event_type,
          occurredAt: new Date(row.occurred_at).toISOString(), payload: row.payload,
        });
        await publish(event);
        await connection.query(
          `UPDATE platform_audit_jobs.outbox_events SET published_at = CURRENT_TIMESTAMP
            WHERE tenant_id = $1 AND id = $2`, [tenantId, event.id],
        );
        return true;
      });
    },

    async consume(consumer, event, handle) {
      const values = [event.tenantId, consumer, event.id];
      return transactions.run(event.tenantId, async (connection) => {
        const inserted = await connection.query(
          `INSERT INTO platform_audit_jobs.inbox_dedup (tenant_id, consumer, event_id)
           VALUES ($1, $2, $3) ON CONFLICT (consumer, event_id) DO NOTHING`, values,
        );
        if (inserted.rowCount === 0) {
          const duplicate = await connection.query(
            `SELECT 1 FROM platform_audit_jobs.inbox_dedup
              WHERE tenant_id = $1 AND consumer = $2 AND event_id = $3`, values,
          );
          if (duplicate.rowCount === 0) throw new InvalidDelivery('tenant_conflict');
          return 'duplicate';
        }
        await handle(event, connection);
        return 'handled';
      });
    },
  };
}

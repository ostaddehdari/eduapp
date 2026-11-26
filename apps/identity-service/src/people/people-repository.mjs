import { randomUUID } from 'node:crypto';

const profile = row => ({ id: row.id, displayName: row.display_name });

export function createPeopleRepository({ transactions }) {
  return Object.freeze({
    list({ tenantId, position, limit }) {
      return transactions.run(tenantId, async (connection) => {
        const { rows } = await connection.query(
          `SELECT id, display_name FROM people_fields.persons
            WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id > $2)
            ORDER BY id LIMIT $3`, [tenantId, position, limit + 1],
        );
        const data = rows.slice(0, limit).map(profile);
        return { data, nextPosition: rows.length > limit ? data.at(-1).id : null };
      });
    },
    get({ tenantId, profileId }) {
      return transactions.run(tenantId, async (connection) => {
        const { rows } = await connection.query(
          'SELECT id, display_name FROM people_fields.persons WHERE tenant_id = $1 AND id = $2', [tenantId, profileId],
        );
        return rows[0] ? profile(rows[0]) : null;
      });
    },
    create({ tenantId, identityId, displayName }) {
      return transactions.run(tenantId, async (connection) => {
        const { rows } = await connection.query(
          `INSERT INTO people_fields.persons (tenant_id, identity_id, display_name) VALUES ($1, $2, $3)
           ON CONFLICT (tenant_id, identity_id) WHERE identity_id IS NOT NULL DO NOTHING
           RETURNING id, display_name`, [tenantId, identityId, displayName],
        );
        if (!rows[0]) return null;
        await connection.query('SELECT platform_audit_jobs.append_outbox($1, $2, $3)', [
          randomUUID(), 'people.profile_changed.v1', { person_id: rows[0].id, version: 1 },
        ]);
        return profile(rows[0]);
      });
    },
  });
}

const roleColumns = 'id, name, version, rules, builtin';
const activeMembership = "status = 'active' AND (expires_at IS NULL OR expires_at > statement_timestamp())";

const roleRecord = (row) => ({
  roleId: row.id, name: row.name, version: row.version, rules: row.rules, builtin: row.builtin,
});

export function createPostgresAccessRepository({ transactions, appendSecurityEvent, registryOwnerInvitations }) {
  const ownerJoin = registryOwnerInvitations ? `
    LEFT JOIN identity_access.registry_owner_receipts AS receipt
      ON receipt.tenant_id = m.tenant_id AND receipt.membership_id = m.id
  ` : '';
  const ownerColumn = registryOwnerInvitations
    ? "(receipt.membership_id IS NOT NULL AND r.builtin AND r.name = 'Tenant owner' AND b.scope_org_id IS NULL)"
    : 'false';
  return Object.freeze({
    readBindings({ tenantId, membershipId, identityId }) {
      return transactions.run(tenantId, async db => {
        const { rows } = await db.query(`
          SELECT b.scope_org_id, r.rules, ${ownerColumn} AS bootstrap_owner FROM identity_access.memberships AS m
          JOIN identity_access.role_bindings AS b ON b.tenant_id = m.tenant_id AND b.membership_id = m.id
          JOIN identity_access.roles AS r ON r.tenant_id = b.tenant_id AND r.id = b.role_id
          ${ownerJoin}
          WHERE m.tenant_id = $1 AND m.id = $2 AND m.identity_id = $3 AND m.status = 'active'
            AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
            AND (b.expires_at IS NULL OR b.expires_at > statement_timestamp())
        `, [tenantId, membershipId, identityId]);
        return rows.map(row => ({
          orgUnitId: row.scope_org_id,
          rules: row.bootstrap_owner
            ? [...row.rules, { action: 'access.invitation.create', effect: 'allow' }]
            : row.rules,
        }));
      });
    },

    listRoles({ tenantId, position, limit, principal, requestId }) {
      return transactions.run(tenantId, async db => {
        const { rows } = await db.query(`
          SELECT ${roleColumns} FROM identity_access.roles
          WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id > $2)
          ORDER BY id LIMIT $3
        `, [tenantId, position, limit + 1]);
        const data = rows.slice(0, limit).map(roleRecord);
        await appendSecurityEvent?.(db, { event: 'security.sensitive_access.v1', principal, requestId });
        return { data, nextPosition: rows.length > limit ? data.at(-1).roleId : null };
      });
    },

    getRole({ tenantId, roleId }) {
      return transactions.run(tenantId, async db => {
        const { rows: [row] } = await db.query(`
          SELECT ${roleColumns} FROM identity_access.roles WHERE tenant_id = $1 AND id = $2
        `, [tenantId, roleId]);
        return row ? roleRecord(row) : null;
      });
    },

    async createRole({ tenantId, name, rules, principal, requestId }) {
      try {
        return await transactions.run(tenantId, async db => {
          const { rows: [row] } = await db.query(`
            INSERT INTO identity_access.roles (tenant_id, name, version, rules)
            VALUES ($1, $2, 1, $3::jsonb) RETURNING ${roleColumns}
          `, [tenantId, name, JSON.stringify(rules)]);
          await appendSecurityEvent?.(db, { event: 'security.role_created.v1', principal, requestId, resourceId: row.id });
          return roleRecord(row);
        });
      } catch (error) {
        if (error.code === '23505') return null;
        throw error;
      }
    },

    async updateRole({ tenantId, roleId, version, name, rules, principal, requestId }) {
      try {
        return await transactions.run(tenantId, async db => {
          const { rows: [current] } = await db.query(`
            SELECT version, builtin FROM identity_access.roles
            WHERE tenant_id = $1 AND id = $2 FOR UPDATE
          `, [tenantId, roleId]);
          if (!current || current.builtin) return { status: 'missing' };
          if (current.version !== version) return { status: 'stale' };
          const { rows: [updated] } = await db.query(`
            UPDATE identity_access.roles SET name = $3, rules = $4::jsonb, version = version + 1
            WHERE tenant_id = $1 AND id = $2 RETURNING ${roleColumns}
          `, [tenantId, roleId, name, JSON.stringify(rules)]);
          await appendSecurityEvent?.(db, { event: 'security.role_updated.v1', principal, requestId, resourceId: roleId });
          return { status: 'updated', role: roleRecord(updated) };
        });
      } catch (error) {
        if (error.code === '23505') return { status: 'conflict' };
        throw error;
      }
    },

    assignRole({ tenantId, roleId, version, membershipId, orgUnitId, expiresAt, principal, requestId }) {
      return transactions.run(tenantId, async db => {
        const member = await db.query(`
          SELECT 1 FROM identity_access.memberships
          WHERE tenant_id = $1 AND id = $2 AND (org_unit_id IS NULL OR org_unit_id = $3::uuid)
            AND ${activeMembership}
          FOR UPDATE
        `, [tenantId, membershipId, orgUnitId]);
        if (member.rowCount !== 1) return null;
        const role = await db.query(`
          SELECT 1 FROM identity_access.roles
          WHERE tenant_id = $1 AND id = $2 AND version = $3 AND builtin = false FOR UPDATE
        `, [tenantId, roleId, version]);
        if (role.rowCount !== 1) return null;
        const values = [tenantId, membershipId, roleId, orgUnitId, expiresAt];
        const active = await db.query(`
          SELECT id FROM identity_access.role_bindings
          WHERE tenant_id = $1 AND membership_id = $2 AND role_id = $3
            AND scope_org_id IS NOT DISTINCT FROM $4::uuid AND expires_at IS NOT DISTINCT FROM $5::timestamptz
            AND (expires_at IS NULL OR expires_at > statement_timestamp())
          ORDER BY id LIMIT 1
        `, values);
        let row = active.rows[0];
        if (!row) {
          const inserted = await db.query(`
            INSERT INTO identity_access.role_bindings (tenant_id, membership_id, role_id, scope_org_id, expires_at)
            SELECT $1, $2, $3, $4, $5 WHERE $5::timestamptz IS NULL OR $5 > statement_timestamp()
            RETURNING id
          `, values);
          row = inserted.rows[0];
          if (row) {
            await appendSecurityEvent?.(db, { event: 'security.role_assigned.v1', principal, requestId, resourceId: row.id });
          }
        }
        return row ? { roleBindingId: row.id, membershipId, roleId, orgUnitId, expiresAt } : null;
      });
    },
  });
}

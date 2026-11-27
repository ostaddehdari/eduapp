import { randomUUID } from 'node:crypto';

const membershipColumns = 'id, tenant_id, identity_id, org_unit_id';
const active = "status = 'active' AND (expires_at IS NULL OR expires_at > statement_timestamp())";

function membershipRecord(row) {
  return { membershipId: row.id, tenantId: row.tenant_id, identityId: row.identity_id, orgUnitId: row.org_unit_id };
}

async function ensureMembership(connection, { tenantId, identityId, orgUnitId }, onCreated) {
  const scope = [tenantId, identityId, orgUnitId];
  await connection.query(
    `UPDATE identity_access.memberships SET status = 'expired'
      WHERE tenant_id = $1 AND identity_id = $2 AND org_unit_id IS NOT DISTINCT FROM $3::uuid
        AND status = 'active' AND expires_at <= statement_timestamp()`, scope,
  );
  const inserted = await connection.query(
    `INSERT INTO identity_access.memberships (tenant_id, identity_id, org_unit_id, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (tenant_id, identity_id, org_unit_id) WHERE status = 'active' DO NOTHING
     RETURNING ${membershipColumns}`, scope,
  );
  if (inserted.rows[0]) {
    const record = membershipRecord(inserted.rows[0]);
    await onCreated?.(record);
    return record;
  }
  const { rows } = await connection.query(
    `SELECT ${membershipColumns} FROM identity_access.memberships
      WHERE tenant_id = $1 AND identity_id = $2 AND org_unit_id IS NOT DISTINCT FROM $3::uuid AND ${active}
      FOR UPDATE`, scope,
  );
  return rows[0] ? membershipRecord(rows[0]) : null;
}

async function liveInvitationScope(connection, orgUnitId) {
  const result = await connection.query('SELECT tenancy_organization.invitation_scope_live($1) AS live', [orgUnitId]);
  return result.rows[0].live === true;
}

function issuedInvitation(row) {
  return { invitationId: row.id, expiresAt: row.expires_at.toISOString() };
}

async function issueScopedInvitation(connection, target, onCreated) {
  const { tenantId, identityId, orgUnitId, invitedByMembershipId, tokenHash, requestKey, expiresInHours } = target;
  if (!await liveInvitationScope(connection, orgUnitId)) return { outcome: 'missing' };
  const issuer = await connection.query(`
    SELECT 1 FROM identity_access.memberships
    WHERE tenant_id = $1 AND id = $2 AND (org_unit_id IS NULL OR org_unit_id = $3) AND ${active}
    FOR SHARE
  `, [tenantId, invitedByMembershipId, orgUnitId]);
  if (!issuer.rowCount) return { outcome: 'missing' };
  const { rows: [inserted] } = await connection.query(`
    INSERT INTO identity_access.invitations
      (tenant_id, id, identity_id, org_unit_id, invited_by_membership_id, token_hash, request_key, expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,statement_timestamp() + make_interval(hours => $8::integer))
    ON CONFLICT (tenant_id, invited_by_membership_id, request_key) WHERE request_key IS NOT NULL DO NOTHING
    RETURNING id, expires_at
  `, [tenantId, randomUUID(), identityId, orgUnitId, invitedByMembershipId, tokenHash, requestKey, expiresInHours]);
  if (inserted) {
    await onCreated(inserted.id);
    return { ...issuedInvitation(inserted), outcome: 'pending' };
  }
  const { rows: [existing] } = await connection.query(`
    SELECT id, expires_at, delivered_at,
      identity_id = $4 AND org_unit_id IS NOT DISTINCT FROM $5::uuid AND token_hash = $6
        AND expires_at = created_at + make_interval(hours => $7::integer) AS same_command,
      expires_at > statement_timestamp() AND revoked_at IS NULL AS live
    FROM identity_access.invitations WHERE tenant_id = $1 AND invited_by_membership_id = $2 AND request_key = $3
  `, [tenantId, invitedByMembershipId, requestKey, identityId, orgUnitId, tokenHash, expiresInHours]);
  if (!existing?.same_command || (!existing.delivered_at && !existing.live)) return { outcome: 'conflict' };
  return { ...issuedInvitation(existing), outcome: existing.delivered_at ? 'delivered' : 'pending' };
}

export function createAccessRepository({ transactions, appendSecurityEvent, scopedInvitations = false }) {
  return Object.freeze({
    resolveMembership({ tenantId, identityId, membershipId }) {
      return transactions.run(tenantId, async (connection) => {
        const { rows } = await connection.query(
          `SELECT ${membershipColumns} FROM identity_access.memberships
            WHERE tenant_id = $1 AND identity_id = $2 AND ($3::uuid IS NULL OR id = $3) AND ${active}
            ORDER BY id LIMIT 2`, [tenantId, identityId, membershipId ?? null],
        );
        if (rows.length !== 1) return null;
        const { membershipId: id, tenantId: tenant, orgUnitId } = membershipRecord(rows[0]);
        return { membershipId: id, tenantId: tenant, orgUnitId };
      });
    },
    hasActiveMembership({ tenantId, identityId }) {
      return transactions.run(tenantId, async (connection) => {
        const result = await connection.query(
          `SELECT 1 FROM identity_access.memberships WHERE tenant_id = $1 AND identity_id = $2 AND ${active} LIMIT 1`,
          [tenantId, identityId],
        );
        return result.rowCount === 1;
      });
    },
    addMembership(scope, auditContext) {
      return transactions.run(scope.tenantId, connection => ensureMembership(connection, scope, async ({ membershipId }) => {
        if (!auditContext) return;
        await appendSecurityEvent?.(connection, {
          ...auditContext, event: 'security.membership_delegated.v1', resourceId: membershipId,
        });
      }));
    },
    issueInvitation(target, auditContext) {
      const { tenantId, identityId, orgUnitId, invitedByMembershipId, tokenHash } = target;
      return transactions.run(tenantId, async (connection) => {
        async function audit(id) {
          if (!auditContext) return;
          await appendSecurityEvent?.(connection, { ...auditContext, event: 'security.invitation_delegated.v1', resourceId: id });
        }
        if (scopedInvitations) return issueScopedInvitation(connection, target, audit);
        const id = randomUUID();
        const { rows } = await connection.query(
          `INSERT INTO identity_access.invitations
            (tenant_id, id, identity_id, org_unit_id, invited_by_membership_id, token_hash)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING expires_at`,
          [tenantId, id, identityId, orgUnitId, invitedByMembershipId, tokenHash],
        );
        await audit(id);
        return { invitationId: id, expiresAt: rows[0].expires_at.toISOString() };
      });
    },
    markInvitationDelivered({ tenantId, invitationId }) {
      return transactions.run(tenantId, async (connection) => {
        const result = await connection.query(`
          UPDATE identity_access.invitations SET delivered_at = COALESCE(delivered_at, statement_timestamp())
          WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL AND expires_at > statement_timestamp()
        `, [tenantId, invitationId]);
        return result.rowCount === 1;
      });
    },
    revokeUndeliveredInvitation({ tenantId, invitationId }) {
      return transactions.run(tenantId, connection => connection.query(
        `UPDATE identity_access.invitations SET revoked_at = statement_timestamp()
          WHERE tenant_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`, [tenantId, invitationId],
      ));
    },
    acceptInvitation({ tenantId, identityId, tokenHash }) {
      return transactions.run(tenantId, async (connection) => {
        const { rows } = await connection.query(
          `SELECT id, org_unit_id FROM identity_access.invitations
            WHERE tenant_id = $1 AND identity_id = $2 AND token_hash = $3
              AND accepted_at IS NULL AND revoked_at IS NULL
              ${scopedInvitations ? 'AND delivered_at IS NOT NULL' : ''}
            FOR UPDATE`, [tenantId, identityId, tokenHash],
        );
        const invitation = rows[0];
        if (!invitation) return null;
        if (scopedInvitations && !await liveInvitationScope(connection, invitation.org_unit_id)) return null;
        const live = await connection.query(
          'SELECT 1 FROM identity_access.invitations WHERE tenant_id = $1 AND id = $2 AND expires_at > statement_timestamp()',
          [tenantId, invitation.id],
        );
        if (!live.rowCount) return null;
        const membership = await ensureMembership(connection, { tenantId, identityId, orgUnitId: invitation.org_unit_id });
        if (!membership) return null;
        await connection.query(
          `UPDATE identity_access.invitations SET accepted_at = statement_timestamp(), accepted_membership_id = $3
            WHERE tenant_id = $1 AND id = $2`, [tenantId, invitation.id, membership.membershipId],
        );
        return membership;
      });
    },
  });
}

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const isUuid = value => typeof value === 'string' && uuidPattern.test(value);
const versionLimit = 2_147_483_647;
const maxPlatformScopes = 50;
const maxRows = 100;
const tenantColumns = 'id, slug, display_name, status, version';
const approvalColumns = 'id, target_status, expected_version, state, requested_by, requested_at, decided_at';
const budget = Object.freeze({ max: 30, windowSeconds: 60 });

export class ManagementError extends Error {}
const fail = code => { throw new ManagementError(code); };

function requestedFields(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).some(key => !fields.includes(key))) fail('VALIDATION_FAILED');
}

function isSession(identity) {
  return isUuid(identity?.actor) && isUuid(identity?.sessionId) && identity.identityId === identity.actor;
}

function isPlatformSession(identity) {
  return isSession(identity) && identity.scope === 'identity-bootstrap' &&
    identity.tenantId === null && identity.membershipId === null && identity.orgUnitId === null;
}

function isTenantSession(identity) {
  return isSession(identity) && isUuid(identity.tenantId) && identity.scope === identity.tenantId &&
    isUuid(identity.membershipId) && (identity.orgUnitId === null || isUuid(identity.orgUnitId));
}

const tenantDto = row => ({ id: row.id, slug: row.slug, displayName: row.display_name, status: row.status, version: row.version });

function approvalDto(row, actor, permission) {
  return {
    id: row.id, targetStatus: row.target_status, expectedVersion: row.expected_version, state: row.state,
    requestedAt: row.requested_at.toISOString(), decidedAt: row.decided_at?.toISOString() ?? null,
    canDecide: permission && row.state === 'pending' && row.requested_by !== actor,
  };
}

async function readTenant(db, tenantId, lock = false) {
  const { rows } = await db.query(`
    SELECT ${tenantColumns} FROM tenancy_organization.tenants
    WHERE id = $1 AND deleted_at IS NULL AND display_name IS NOT NULL AND owner_membership_id IS NOT NULL
    ${lock ? 'FOR UPDATE' : ''}
  `, [tenantId]);
  return rows[0];
}

async function recordOutcome(db, { tenantId, approvalId, requestId, actor, requester, outcome, version }) {
  await db.query(`
    INSERT INTO tenancy_organization.management_status_audit
      (tenant_id, approval_id, request_id, actor_id, requester_id, outcome, result_version)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [tenantId, approvalId, requestId, actor, requester, outcome, version]);
}

// These ports each use the source owner's credential and bind one verified tenant.
export function createManagementReadPorts({ billingTransactions, accessTransactions }) {
  if (typeof billingTransactions?.run !== 'function' || typeof accessTransactions?.run !== 'function' ||
    billingTransactions === accessTransactions) throw new TypeError('Management read requires separate Billing and Access owner transactions');

  return Object.freeze({
    readQuota({ tenantId }) {
      return billingTransactions.run(tenantId, async db => {
        const { rows } = await db.query(`
          SELECT feature, limit_value::text AS quota_limit, valid_to FROM commercial_billing.entitlements
          WHERE tenant_id = $1 AND (valid_to IS NULL OR valid_to > statement_timestamp())
          ORDER BY feature, valid_to DESC NULLS LAST, id LIMIT $2
        `, [tenantId, maxRows]);
        return rows.map(row => ({ feature: row.feature, limit: row.quota_limit, validTo: row.valid_to?.toISOString() ?? null }));
      });
    },
    readManagers({ tenantId, orgUnitId }) {
      return accessTransactions.run(tenantId, async db => {
        const { rows } = await db.query(`
          WITH eligible AS (
            SELECT m.id AS membership_id, COALESCE(m.org_unit_id, b.scope_org_id) AS org_unit_id,
                   r.name AS role_name, rule->>'action' AS action, rule->>'effect' AS effect
            FROM identity_access.memberships AS m
            JOIN identity_access.role_bindings AS b ON b.tenant_id = m.tenant_id AND b.membership_id = m.id
            JOIN identity_access.roles AS r ON r.tenant_id = b.tenant_id AND r.id = b.role_id
            CROSS JOIN LATERAL jsonb_array_elements(r.rules) AS rule
            WHERE m.tenant_id = $1 AND m.status = 'active'
              AND (m.expires_at IS NULL OR m.expires_at > statement_timestamp())
              AND (b.expires_at IS NULL OR b.expires_at > statement_timestamp())
              AND (m.org_unit_id IS NULL OR b.scope_org_id IS NULL OR m.org_unit_id = b.scope_org_id)
              AND rule->>'action' IN ('tenancy.org.write', 'access.invitation.create')
              AND rule->>'relationship' IS NULL
          )
          SELECT DISTINCT allowed.membership_id, allowed.org_unit_id, allowed.role_name
          FROM eligible AS allowed
          WHERE allowed.effect = 'allow' AND ($2::uuid IS NULL OR allowed.org_unit_id = $2)
            AND NOT EXISTS (
              SELECT FROM eligible AS denied WHERE denied.membership_id = allowed.membership_id
                AND denied.effect = 'deny' AND denied.action = allowed.action
                AND (denied.org_unit_id IS NULL OR denied.org_unit_id = allowed.org_unit_id)
            )
          ORDER BY allowed.membership_id, allowed.org_unit_id, allowed.role_name LIMIT $3
        `, [tenantId, orgUnitId, maxRows]);
        return rows.map(row => ({ membershipId: row.membership_id, orgUnitId: row.org_unit_id, roleName: row.role_name }));
      });
    },
  });
}

export function createManagementService({ transactions, authorize, resolvePlatformScopes, requireRecentMfa, readQuota, readManagers }) {
  if ([transactions?.run, authorize, resolvePlatformScopes, requireRecentMfa, readQuota, readManagers]
    .some(port => typeof port !== 'function')) throw new TypeError('Management requires scoped owner and authorization ports');

  async function platformScopes(identity) {
    if (!isPlatformSession(identity)) fail('FORBIDDEN');
    const scopes = await resolvePlatformScopes({ identity });
    if (!Array.isArray(scopes) || scopes.length > maxPlatformScopes) fail('FORBIDDEN');
    const map = new Map();
    for (const entry of scopes) {
      if (!isUuid(entry?.tenantId) || map.has(entry.tenantId)) fail('FORBIDDEN');
      map.set(entry.tenantId, {
        requestStatusChange: entry.requestStatusChange === true,
        decideStatusChange: entry.decideStatusChange === true,
      });
    }
    return map;
  }

  async function selectedOverview({ identity, tenant, orgUnitId, permission, platform }) {
    const tenantId = tenant.id;
    const details = await transactions.run(tenantId, async db => {
      const { rows: units } = await db.query(`
        SELECT id, parent_id, kind, code, COALESCE(name, code) AS name FROM tenancy_organization.org_units
        WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY code, id LIMIT $3
      `, [tenantId, orgUnitId, maxRows]);
      if (orgUnitId !== null && units.length !== 1) fail('NOT_FOUND');
      const branches = units.map(row => ({
        id: row.id, parentId: orgUnitId === null ? row.parent_id : null, kind: row.kind, code: row.code, name: row.name,
      }));
      const approvals = platform ? (await db.query(`
        SELECT ${approvalColumns} FROM tenancy_organization.management_status_requests
        WHERE tenant_id = $1 ORDER BY (state = 'pending') DESC, requested_at DESC, id LIMIT $2
      `, [tenantId, maxRows])).rows.map(row => approvalDto(row, identity.actor, permission.decideStatusChange)) : [];
      return { branches, approvals };
    });
    const [quotas, managers] = await Promise.all([
      orgUnitId === null ? readQuota({ tenantId }) : [],
      readManagers({ tenantId, orgUnitId }),
    ]);
    return { tenant, ...details, quotas, managers };
  }

  async function permissionToChange(identity, tenantId, capability) {
    const scope = (await platformScopes(identity)).get(tenantId);
    if (!scope || scope[capability] !== true || await requireRecentMfa(identity) !== true) fail('FORBIDDEN');
    return scope;
  }

  return Object.freeze({
    async overview({ identity, query }) {
      const target = query?.tenantId;
      const noChange = { requestStatusChange: false, decideStatusChange: false };
      if (target !== undefined && !isUuid(target)) fail('VALIDATION_FAILED');
      if (isPlatformSession(identity)) {
        const scopes = await platformScopes(identity);
        if (scopes.size === 0) fail('FORBIDDEN');
        if (target !== undefined && !scopes.has(target)) fail('NOT_FOUND');
        const rows = await Promise.all([...scopes.keys()].map(id => transactions.run(id, db => readTenant(db, id))));
        const tenants = rows.filter(Boolean).map(tenantDto).sort((a, b) => a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id));
        const tenant = target === undefined ? null : tenants.find(row => row.id === target);
        if (!tenant && target !== undefined) fail('NOT_FOUND');
        const permissions = tenant ? scopes.get(tenant.id) : noChange;
        const selected = tenant ? await selectedOverview({ identity, tenant, orgUnitId: null, permission: permissions, platform: true }) : null;
        return { mode: 'platform', tenants, selected, permissions };
      }
      if (!isTenantSession(identity) || (target !== undefined && target !== identity.tenantId)) fail('NOT_FOUND');
      const { tenantId, orgUnitId } = identity;
      const scope = { identity, tenantId, orgUnitId, targetOrgUnitId: orgUnitId };
      if (await authorize({ ...scope, action: 'tenancy.tenant.read' }) !== true ||
          await authorize({ ...scope, action: 'tenancy.org.read' }) !== true) fail('FORBIDDEN');
      const row = await transactions.run(tenantId, db => readTenant(db, tenantId));
      if (!row || row.status !== 'active') fail('NOT_FOUND');
      const tenant = tenantDto(row);
      const selected = await selectedOverview({ identity, tenant, orgUnitId, permission: noChange, platform: false });
      return { mode: 'organization', tenants: [tenant], selected, permissions: noChange };
    },
    async requestStatusChange({ identity, body, requestId }) {
      requestedFields(body, ['tenantId', 'targetStatus', 'expectedVersion']);
      const { tenantId, targetStatus, expectedVersion } = body;
      if (!isUuid(tenantId) || !isUuid(requestId) || !['active', 'suspended'].includes(targetStatus) ||
          !Number.isInteger(expectedVersion) || expectedVersion < 1 || expectedVersion >= versionLimit) fail('VALIDATION_FAILED');
      await permissionToChange(identity, tenantId, 'requestStatusChange');
      return transactions.run(tenantId, async db => {
        const current = await readTenant(db, tenantId, true);
        if (!current) fail('NOT_FOUND');
        if (current.version !== expectedVersion) fail('PRECONDITION_FAILED');
        if (current.status === targetStatus) fail('CONFLICT');
        const { rows: [record] } = await db.query(`
          INSERT INTO tenancy_organization.management_status_requests (tenant_id, target_status, expected_version, requested_by)
          VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id) WHERE state = 'pending' DO NOTHING
          RETURNING ${approvalColumns}
        `, [tenantId, targetStatus, expectedVersion, identity.actor]);
        if (!record) fail('CONFLICT');
        await recordOutcome(db, { tenantId, approvalId: record.id, requestId, actor: identity.actor,
          requester: identity.actor, outcome: 'requested', version: current.version });
        return approvalDto(record, identity.actor, false);
      });
    },
    async decideStatusChange({ identity, body, params, requestId }) {
      requestedFields(body, ['tenantId', 'decision']);
      const { tenantId, decision } = body;
      const approvalId = params?.requestId;
      if (!isUuid(tenantId) || !isUuid(requestId) || !isUuid(approvalId) || !['approve', 'reject'].includes(decision)) fail('VALIDATION_FAILED');
      await permissionToChange(identity, tenantId, 'decideStatusChange');
      return transactions.run(tenantId, async db => {
        const current = await readTenant(db, tenantId, true);
        if (!current) fail('NOT_FOUND');
        const { rows: [record] } = await db.query(`
          SELECT ${approvalColumns} FROM tenancy_organization.management_status_requests
          WHERE tenant_id = $1 AND id = $2 FOR UPDATE
        `, [tenantId, approvalId]);
        if (!record) fail('NOT_FOUND');
        if (record.requested_by === identity.actor) fail('FORBIDDEN');
        if (record.state !== 'pending') fail('CONFLICT');

        let state = 'rejected';
        let version = current.version;
        if (decision === 'approve') {
          const applies = version === record.expected_version && current.status !== record.target_status && version < versionLimit;
          state = applies ? 'approved' : 'stale';
        }
        if (state === 'approved') {
          const result = await db.query(`
            UPDATE tenancy_organization.tenants SET status = $2, version = version + 1, updated_at = statement_timestamp()
            WHERE id = $1 AND version = $3 RETURNING version
          `, [tenantId, record.target_status, version]);
          if (result.rowCount !== 1) fail('PRECONDITION_FAILED');
          version = result.rows[0].version;
          await db.query(`
            INSERT INTO tenancy_organization.registry_audit_facts (tenant_id, actor_id, request_id, action, occurred_at)
            VALUES ($1, $2, $3, $4, statement_timestamp())
          `, [tenantId, identity.actor, requestId, record.target_status === 'suspended' ? 'tenant_suspended' : 'tenant_reactivated']);
        }
        const { rows: [updated] } = await db.query(`
          UPDATE tenancy_organization.management_status_requests
          SET state = $3, decided_by = $4, decided_at = statement_timestamp(), result_version = $5
          WHERE tenant_id = $1 AND id = $2 AND state = 'pending' RETURNING ${approvalColumns}
        `, [tenantId, approvalId, state, identity.actor, version]);
        if (!updated) fail('CONFLICT');
        await recordOutcome(db, { tenantId, approvalId, requestId, actor: identity.actor,
          requester: record.requested_by, outcome: state, version });
        return approvalDto(updated, identity.actor, false);
      });
    },
  });
}

export function createManagementRoutes({ service, GatewayError }) {
  const route = (id, method, status = 200, queryKeys = []) => ({
    id, budget, queryKeys,
    authorize: ({ identity }) => isSession(identity),
    async handle(input) {
      try {
        return { status, data: await service[method](input) };
      } catch (error) {
        if (error instanceof ManagementError) throw new GatewayError(error.message);
        throw error;
      }
    },
  });
  return [
    route('getManagementOverview', 'overview', 200, ['tenantId']),
    route('createManagementStatusRequest', 'requestStatusChange', 201),
    route('decideManagementStatusRequest', 'decideStatusChange'),
  ];
}

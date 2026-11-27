const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isUuid = (input) => typeof input === 'string' && uuidPattern.test(input);
const roleEvents = new Set([
  'security.role_created.v1',
  'security.role_updated.v1',
  'security.role_assigned.v1',
  'security.membership_delegated.v1',
  'security.invitation_delegated.v1',
]);
const sensitiveAccess = 'security.sensitive_access.v1';
const login = 'security.login.v1';

function invalidAudit() {
  return new TypeError('Invalid security audit event');
}

function optionalUuid(input) {
  if (input == null) return null;
  if (!isUuid(input)) throw invalidAudit();
  return input;
}

function trustedScope(principal) {
  const actor = principal?.actor ?? principal?.identityId;
  const { tenantId, membershipId } = principal ?? {};
  if (!isUuid(actor) || !isUuid(tenantId) || !isUuid(membershipId) ||
    (principal.identityId != null && principal.identityId !== actor) ||
    (principal.scope != null && principal.scope !== tenantId)) throw invalidAudit();
  return { actor, tenantId, membershipId };
}

async function appendScoped(db, event, { actor, membershipId }, requestId, resourceId, outcome) {
  await db.query(
    'SELECT platform_audit_jobs.append_security_audit($1, $2, $3, $4, $5, $6)',
    [event, actor, membershipId, requestId, resourceId, outcome],
  );
}

export async function appendTenantSecurityEvent(db, { event, outcome = 'success', principal, resourceId, requestId }) {
  if ((!roleEvents.has(event) && event !== sensitiveAccess) || !['success', 'denied'].includes(outcome)) throw invalidAudit();
  const scope = trustedScope(principal);
  const resource = outcome === 'success' ? optionalUuid(resourceId) : null;
  if (roleEvents.has(event) && outcome === 'success' && resource === null) throw invalidAudit();
  await appendScoped(db, event, scope, optionalUuid(requestId), resource, outcome);
}

export async function appendIamSecurityEvent(db, {
  event = login, outcome, actorId, requestId, tenantId, membershipId, sessionId,
}) {
  const tenant = optionalUuid(tenantId);
  const membership = optionalUuid(membershipId);
  const session = optionalUuid(sessionId);
  if (event !== login || !['success', 'denied', 'error'].includes(outcome) ||
    (outcome === 'success' && !isUuid(actorId)) || (tenant === null) !== (membership === null) ||
    (outcome !== 'success' && (tenant !== null || session !== null))) throw invalidAudit();
  await db.query(
    `INSERT INTO identity_access.security_login_facts (actor_id, request_id, tenant_id, membership_id, session_id, outcome)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [optionalUuid(actorId), optionalUuid(requestId), tenant, membership, session, outcome],
  );
}

export function createSecurityAudit({ accessTransactions, peopleTransactions, iamPool } = {}) {
  return Object.freeze({
    recordTenant(input) {
      const owner = input.owner ?? (input.event === sensitiveAccess ? 'people' : 'access');
      if (owner !== 'access' && (owner !== 'people' || input.event !== sensitiveAccess)) throw invalidAudit();
      const transactions = owner === 'people' ? peopleTransactions : accessTransactions;
      if (!transactions) throw new Error('Security audit writer is unavailable');
      const scope = trustedScope(input.principal);
      return transactions.run(scope.tenantId, db => appendTenantSecurityEvent(db, input));
    },

    recordIam(input) {
      if (!iamPool) throw new Error('Security audit writer is unavailable');
      return appendIamSecurityEvent(iamPool, input);
    },
  });
}

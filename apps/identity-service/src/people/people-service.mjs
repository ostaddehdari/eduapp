import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const invitePattern = /^[A-Za-z0-9_-]{43}$/;
const isUuid = value => typeof value === 'string' && uuidPattern.test(value);
const hash = value => createHash('sha256').update(value, 'ascii').digest();

export class PeopleError extends Error {}

const fail = code => { throw new PeopleError(code); };
const uuid = value => isUuid(value) ? value.toLowerCase() : fail('VALIDATION_FAILED');

function expectFields(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).some(key => !fields.includes(key))) fail('VALIDATION_FAILED');
}

function identityFromPrincipal(principal) {
  if (!hasInvitationPrincipal(principal)) fail('AUTHENTICATION_REQUIRED');
  return principal.identityId.toLowerCase();
}

export function hasInvitationPrincipal(principal) {
  return isUuid(principal?.identityId) && isUuid(principal?.sessionId);
}

export function hasPeopleScope(identity) {
  return isUuid(identity?.actor) && isUuid(identity?.tenantId) && isUuid(identity?.membershipId) &&
    identity.scope === identity.tenantId;
}

export function createPeopleService({
  people, access, authorize, findActiveIdentity, verifyOrgUnit, deliverInvitation, requireRecentMfa,
  projectProfile, recordSecurityEvent, invitationKey,
}) {
  if (typeof authorize !== 'function' || typeof findActiveIdentity !== 'function') {
    throw new TypeError('People requires owned authorization and identity resolution');
  }
  if (invitationKey !== undefined && (!Buffer.isBuffer(invitationKey) || invitationKey.length < 32)) {
    throw new TypeError('Scoped invitations require an invitation key of at least 32 bytes');
  }
  const scopedKey = invitationKey && Buffer.from(invitationKey);

  async function activeIdentity(identityId) {
    return (await findActiveIdentity({ identityId }))?.id === identityId;
  }

  async function authorizedScope(identity, action, targetOrgUnitId) {
    if (!hasPeopleScope(identity)) fail('NOT_FOUND');
    const actor = identity.actor.toLowerCase();
    const membership = await access.resolveMembership({
      identityId: actor, tenantId: identity.tenantId.toLowerCase(), membershipId: identity.membershipId.toLowerCase(),
    });
    if (!membership || (membership.orgUnitId !== null && membership.orgUnitId !== targetOrgUnitId)) fail('NOT_FOUND');
    const scope = { ...membership, actor, targetOrgUnitId };
    if (await authorize({ ...scope, action }) !== true) fail('FORBIDDEN');
    if (targetOrgUnitId !== null && await verifyOrgUnit?.({ tenantId: scope.tenantId, orgUnitId: targetOrgUnitId }) !== true) {
      fail('NOT_FOUND');
    }
    return scope;
  }

  async function membershipTarget(identity, body, action, fields = ['identityId', 'orgUnitId']) {
    expectFields(body, fields);
    const identityId = uuid(body.identityId);
    const orgUnitId = body.orgUnitId == null ? null : uuid(body.orgUnitId);
    const scope = await authorizedScope(identity, action, orgUnitId);
    if (await requireRecentMfa?.(identity) !== true) fail('FORBIDDEN');
    if (!await activeIdentity(identityId)) fail('NOT_FOUND');
    return { scope, target: { tenantId: scope.tenantId, identityId, orgUnitId } };
  }

  async function project(scope, profile) {
    if (typeof projectProfile !== 'function') return profile;
    const result = await projectProfile({ ...scope, profile });
    if (result === null) fail('NOT_FOUND');
    return result;
  }

  return Object.freeze({
    async listUsers({ identity, page, requestId }) {
      const scope = await authorizedScope(identity, 'people.user.read', null);
      if (!Number.isInteger(page?.limit) || page.limit < 1 || page.limit > 100) fail('VALIDATION_FAILED');
      const position = page.position == null ? null : uuid(page.position);
      const result = await people.list({ tenantId: scope.tenantId, position, limit: page.limit });
      const data = await project(scope, result.data);
      await recordSecurityEvent?.({ event: 'security.sensitive_access.v1', principal: scope, requestId });
      return { ...result, data };
    },
    async getUser({ identity, profileId, requestId }) {
      const scope = await authorizedScope(identity, 'people.user.read', null);
      const resourceId = uuid(profileId);
      const found = await people.get({ tenantId: scope.tenantId, profileId: resourceId });
      if (!found) fail('NOT_FOUND');
      const profile = await project(scope, found);
      await recordSecurityEvent?.({ event: 'security.sensitive_access.v1', principal: scope, resourceId, requestId });
      return profile;
    },
    async createUser({ identity, body }) {
      const { tenantId } = await authorizedScope(identity, 'people.user.write', null);
      expectFields(body, ['displayName', 'identityId']);
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      if (!displayName || [...displayName].length > 120 || /\p{Cc}/u.test(displayName)) {
        fail('VALIDATION_FAILED');
      }
      const identityId = body.identityId == null ? null : uuid(body.identityId);
      if (identityId && (!await activeIdentity(identityId) || !await access.hasActiveMembership({ tenantId, identityId }))) {
        fail('NOT_FOUND');
      }
      const profile = await people.create({ tenantId, identityId, displayName });
      if (!profile) fail('CONFLICT');
      return profile;
    },
    async createMembership({ identity, body, requestId }) {
      const { scope, target } = await membershipTarget(identity, body, 'access.membership.create');
      const result = await access.addMembership(target, { principal: scope, requestId });
      if (!result) fail('CONFLICT');
      return result;
    },
    async createInvitation({ identity, body, requestId, requestKey }) {
      const fields = scopedKey ? ['identityId', 'orgUnitId', 'expiresInHours'] : ['identityId', 'orgUnitId'];
      const { scope, target } = await membershipTarget(identity, body, 'access.invitation.create', fields);
      if (typeof deliverInvitation !== 'function') fail('SERVICE_UNAVAILABLE');
      const expiresInHours = Object.hasOwn(body, 'expiresInHours') ? body.expiresInHours : 48;
      if (!Number.isInteger(expiresInHours) || expiresInHours < 1 || expiresInHours > 168 ||
          (requestKey !== undefined && !scopedKey)) fail('VALIDATION_FAILED');
      const commandKey = scopedKey ? uuid(requestKey ?? randomUUID()) : null;
      const token = commandKey ? createHmac('sha256', scopedKey).update(JSON.stringify([
        'eduapp.scoped-invitation.v1', scope.tenantId, scope.membershipId, commandKey,
        target.identityId, target.orgUnitId, expiresInHours,
      ])).digest('base64url') : randomBytes(32).toString('base64url');
      const invite = await access.issueInvitation({
        ...target, invitedByMembershipId: scope.membershipId, tokenHash: hash(token),
        ...(scopedKey ? { requestKey: commandKey, expiresInHours } : {}),
      }, { principal: scope, requestId });
      if (invite.outcome === 'missing') fail('NOT_FOUND');
      if (invite.outcome === 'conflict') fail('IDEMPOTENCY_CONFLICT');
      const result = { invitationId: invite.invitationId, expiresAt: invite.expiresAt, status: 'queued' };
      if (invite.outcome === 'delivered') return result;
      try {
        if (await deliverInvitation({ invitationId: invite.invitationId, expiresAt: invite.expiresAt, ...target, token }) !== true) {
          fail('SERVICE_UNAVAILABLE');
        }
        if (scopedKey && await access.markInvitationDelivered({ tenantId: scope.tenantId, invitationId: invite.invitationId }) !== true) {
          fail('SERVICE_UNAVAILABLE');
        }
      } catch {
        if (!scopedKey || requestKey === undefined) {
          await access.revokeUndeliveredInvitation({ tenantId: scope.tenantId, invitationId: invite.invitationId });
        }
        fail('SERVICE_UNAVAILABLE');
      }
      return result;
    },
    async acceptInvitation({ principal, tenantId: targetTenant, token }) {
      const identityId = identityFromPrincipal(principal);
      const tenantId = uuid(targetTenant);
      if (typeof token !== 'string' || !invitePattern.test(token) || !await activeIdentity(identityId)) fail('NOT_FOUND');
      const result = await access.acceptInvitation({ tenantId, identityId, tokenHash: hash(token) });
      if (!result) fail('NOT_FOUND');
      return { tenantId: result.tenantId, membershipId: result.membershipId, orgUnitId: result.orgUnitId };
    },
    async selectContext({ principal, tenantId, membershipId }) {
      const identityId = identityFromPrincipal(principal);
      const result = await access.resolveMembership({ tenantId: uuid(tenantId), membershipId: uuid(membershipId), identityId });
      if (!result || !await activeIdentity(identityId)) fail('NOT_FOUND');
      return result;
    },
  });
}

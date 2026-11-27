import {
  AccessError, actions, decideRules, fail, hasAccessContext, isUuid, maskFields, normalizeRules,
  requireFields, requireUuid,
} from './policy.mjs';

const denied = () => ({ allowed: false, fields: [] });
const tenantTarget = ({ tenantId }, action) => ({ tenantId, orgUnitId: null, action });
const assignmentScope = (actor, tenantId, membershipId) => ({ actor, scope: tenantId, tenantId, membershipId });

function validateRole(body) {
  requireFields(body, ['name', 'rules']);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || [...name].length > 100 || /\p{Cc}/u.test(name)) fail('VALIDATION_FAILED');
  const rules = normalizeRules(body.rules, { custom: true });
  return { name, rules };
}

function roleVersion(ifMatch) {
  if (typeof ifMatch !== 'string' || !/^"[1-9][0-9]{0,9}"$/.test(ifMatch)) fail('VALIDATION_FAILED');
  const version = Number(ifMatch.slice(1, -1));
  if (version >= 2_147_483_647) fail('VALIDATION_FAILED');
  return version;
}

export function createAccessService({
  repository, resolveMembership, verifyGuardian, hasEntitlement, verifyOrgUnit, requireRecentMfa, now = Date.now,
}) {
  if (typeof resolveMembership !== 'function') throw new TypeError('Access requires the membership owner');

  async function activeContext(identity) {
    if (!hasAccessContext(identity)) return null;
    const { actor, tenantId, membershipId } = identity;
    const membership = await resolveMembership({ identityId: actor, tenantId, membershipId });
    if (membership?.tenantId !== tenantId || membership?.membershipId !== membershipId ||
      (membership.orgUnitId !== null && !isUuid(membership.orgUnitId))) return null;
    const bindings = await repository.readBindings({ tenantId, membershipId, identityId: actor });
    return { actor, tenantId, membershipId, orgUnitId: membership.orgUnitId, bindings };
  }

  async function evaluate(context, target) {
    if (!context || typeof target.action !== 'string' || !Object.hasOwn(actions, target.action) ||
      target.tenantId !== context.tenantId ||
      (target.orgUnitId !== null && !isUuid(target.orgUnitId)) ||
      (context.orgUnitId !== null && context.orgUnitId !== target.orgUnitId)) return denied();
    const { tenantId, orgUnitId, subjectId, requiredEntitlement } = target;
    if (requiredEntitlement !== undefined && (
      typeof requiredEntitlement !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(requiredEntitlement) ||
      await hasEntitlement?.({ tenantId, feature: requiredEntitlement }) !== true
    )) return denied();
    let guardian = false;
    if (target.action === 'school.student.read' && orgUnitId !== null && isUuid(subjectId) &&
      context.bindings.some(binding => binding.rules.some(rule => rule.relationship === 'verified_guardian'))) {
      guardian = await verifyGuardian?.({ tenantId, orgUnitId, studentId: subjectId, identityId: context.actor }) === true;
    }
    return decideRules(context.bindings, target, { guardian });
  }

  async function tenantAdmin(identity, action) {
    const context = await activeContext(identity);
    if (!context || (await evaluate(context, tenantTarget(context, action))).allowed !== true) fail('FORBIDDEN');
    if (action !== 'access.role.read' && await requireRecentMfa?.(identity) !== true) fail('FORBIDDEN');
    return context;
  }

  function ensureDelegable(context, rules) {
    for (const rule of rules) {
      if (rule.effect === 'deny') continue;
      const authority = decideRules(context.bindings, tenantTarget(context, rule.action), { guardian: true });
      const unrestricted = decideRules(context.bindings, tenantTarget(context, rule.action), { guardian: false });
      if (!authority.allowed || !unrestricted.allowed ||
        rule.fields.some(field => !authority.fields.includes(field) || !unrestricted.fields.includes(field))) {
        fail('FORBIDDEN');
      }
    }
  }

  const service = Object.freeze({
    async decide(identity, target) {
      if (!hasAccessContext(identity) || identity.tenantId !== target?.tenantId) return denied();
      try {
        return await evaluate(await activeContext(identity), target);
      } catch (error) {
        if (error instanceof AccessError) return denied();
        throw error;
      }
    },
    async can(identity, target) {
      return (await service.decide(identity, target)).allowed;
    },

    async capabilities(identity) {
      const context = await activeContext(identity);
      if (!context) fail('FORBIDDEN');
      const scope = { tenantId: context.tenantId, orgUnitId: context.orgUnitId };
      const result = [];
      for (const action of Object.keys(actions)) {
        // Resource-dependent School access needs the selected record and its entitlement.
        if (action === 'school.student.read') continue;
        const decision = await evaluate(context, { ...scope, action });
        if (decision.allowed) result.push({ action, fields: decision.fields });
      }
      return { ...scope, capabilities: result };
    },

    async listRoles(identity, page) {
      const context = await tenantAdmin(identity, 'access.role.read');
      if (!Number.isInteger(page?.limit) || page.limit < 1 || page.limit > 100) fail('VALIDATION_FAILED');
      const position = page.position === null ? null : requireUuid(page.position);
      return repository.listRoles({ tenantId: context.tenantId, position, limit: page.limit });
    },

    async createRole(identity, body) {
      const context = await tenantAdmin(identity, 'access.role.write');
      const value = validateRole(body);
      ensureDelegable(context, value.rules);
      const role = await repository.createRole({ tenantId: context.tenantId, ...value });
      if (!role) fail('CONFLICT');
      return role;
    },

    async updateRole(identity, roleId, ifMatch, body) {
      const context = await tenantAdmin(identity, 'access.role.write');
      const value = validateRole(body);
      ensureDelegable(context, value.rules);
      const result = await repository.updateRole({
        tenantId: context.tenantId, roleId: requireUuid(roleId), version: roleVersion(ifMatch), ...value,
      });
      if (result.status !== 'updated') fail({
        missing: 'NOT_FOUND', stale: 'PRECONDITION_FAILED', conflict: 'CONFLICT',
      }[result.status] ?? 'SERVICE_UNAVAILABLE');
      return result.role;
    },

    async assignRole(identity, body) {
      const context = await tenantAdmin(identity, 'access.role.assign');
      requireFields(body, ['roleId', 'membershipId', 'orgUnitId', 'expiresAt']);
      const tenantId = context.tenantId;
      const roleId = requireUuid(body.roleId);
      const membershipId = requireUuid(body.membershipId);
      const orgUnitId = body.orgUnitId == null ? null : requireUuid(body.orgUnitId);
      const expiresAt = body.expiresAt ?? null;
      if (expiresAt !== null && (typeof expiresAt !== 'string' ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(expiresAt) ||
        !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= now())) fail('VALIDATION_FAILED');
      if (orgUnitId !== null && await verifyOrgUnit?.({ tenantId, orgUnitId }) !== true) fail('NOT_FOUND');
      const role = await repository.getRole({ tenantId, roleId });
      if (!role || role.builtin) fail('NOT_FOUND');
      ensureDelegable(context, normalizeRules(role.rules, { custom: true }));
      const binding = await repository.assignRole({ tenantId, roleId, version: role.version, membershipId, orgUnitId, expiresAt });
      if (!binding) fail('NOT_FOUND');
      return binding;
    },
  });
  return service;
}

export function createAccessAuthorize(access) {
  return async ({ actor, tenantId, membershipId, targetOrgUnitId, action }) => (
    await access.decide(assignmentScope(actor, tenantId, membershipId), { action, tenantId, orgUnitId: targetOrgUnitId })
  ).allowed;
}

export function createPeopleFieldProjection(access) {
  return async ({ actor, tenantId, membershipId, targetOrgUnitId, profile }) => {
    const decision = await access.decide(assignmentScope(actor, tenantId, membershipId), {
      action: 'people.user.read', tenantId, orgUnitId: targetOrgUnitId,
    });
    if (!decision.allowed) return null;
    return Array.isArray(profile) ? profile.map(record => maskFields(record, decision)) : maskFields(profile, decision);
  };
}

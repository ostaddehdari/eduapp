const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const isUuid = (value) => typeof value === 'string' && uuidPattern.test(value);

export const actions = Object.freeze({
  'access.role.read': [],
  'access.role.write': [],
  'access.role.assign': [],
  'access.membership.create': [],
  'access.invitation.create': [],
  'people.user.read': ['id', 'displayName'],
  'people.user.write': [],
  'school.student.read': ['studentId', 'displayName', 'gradeLevel', 'attendanceStatus'],
  'tenancy.tenant.read': [],
  'tenancy.org.read': [],
  'tenancy.org.write': [],
});

const privileged = new Set(['access.role.read', 'access.role.write', 'access.role.assign', 'tenancy.org.write']);

export class AccessError extends Error {}

export function fail(code) {
  throw new AccessError(code);
}

export function requireUuid(value) {
  if (!isUuid(value)) fail('VALIDATION_FAILED');
  return value;
}

export function requireFields(object, allowed) {
  if (!object || typeof object !== 'object' || Array.isArray(object) ||
    Object.keys(object).some(key => !allowed.includes(key))) fail('VALIDATION_FAILED');
}

export function hasAccessContext(principal) {
  return isUuid(principal?.actor) && isUuid(principal?.tenantId) && isUuid(principal?.membershipId) &&
    principal.scope === principal.tenantId;
}

export function normalizeRules(rules, { custom = false } = {}) {
  if (!Array.isArray(rules) || rules.length > 64) fail('VALIDATION_FAILED');
  return rules.map(rule => {
    requireFields(rule, ['action', 'effect', 'fields', 'relationship']);
    const { action, effect, relationship = null } = rule;
    if (typeof action !== 'string' || !Object.hasOwn(actions, action) || !['allow', 'deny'].includes(effect) ||
      (custom && privileged.has(action)) ||
      (relationship !== null && (relationship !== 'verified_guardian' || action !== 'school.student.read'))) {
      fail('VALIDATION_FAILED');
    }
    const fields = rule.fields ?? [];
    if (!Array.isArray(fields) || fields.length > actions[action].length ||
      fields.some(field => !actions[action].includes(field)) || new Set(fields).size !== fields.length ||
      (effect === 'deny' && fields.length)) fail('VALIDATION_FAILED');
    return { action, effect, relationship, fields };
  });
}

export function decideRules(bindings, target, { guardian = false } = {}) {
  const merged = new Set();
  let allowed = false;
  for (const binding of bindings) {
    if (binding.orgUnitId !== null && binding.orgUnitId !== target.orgUnitId) continue;
    for (const rule of normalizeRules(binding.rules)) {
      if (rule.action !== target.action || (rule.relationship && !guardian)) continue;
      if (rule.effect === 'deny') return { allowed: false, fields: [] };
      allowed = true;
      for (const field of rule.fields) merged.add(field);
    }
  }
  return { allowed, fields: [...merged].sort() };
}

export function maskFields(record, decision) {
  if (decision?.allowed !== true) fail('NOT_FOUND');
  const result = {};
  for (const field of decision.fields) {
    const value = Object.getOwnPropertyDescriptor(record, field)?.value;
    if (value === null || ['boolean', 'number', 'string'].includes(typeof value)) result[field] = value;
  }
  return result;
}

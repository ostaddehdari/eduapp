const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const eventRoutes = Object.freeze({
  'identity.session_revoked.v1': Object.freeze(['platform_audit_jobs']),
  'tenancy.tenant_created.v1': Object.freeze(['identity_access']),
  'tenancy.org_unit_changed.v1': Object.freeze(['identity_access', 'school_enrollment']),
  'people.profile_changed.v1': Object.freeze(['school_enrollment']),
  'fields.definition_published.v1': Object.freeze(['sites_content', 'school_enrollment']),
  'billing.subscription_activated.v1': Object.freeze(['tenancy_organization', 'identity_access']),
  'sites.page_published.v1': Object.freeze(['platform_audit_jobs']),
  'assets.asset_ready.v1': Object.freeze(['sites_content', 'school_enrollment']),
  'school.enrollment_changed.v1': Object.freeze(['attendance', 'notifications_integrations']),
  'attendance.confirmed.v1': Object.freeze(['notifications_integrations', 'platform_audit_jobs']),
  'notifications.delivery_updated.v1': Object.freeze(['platform_audit_jobs']),
});

export const consumerNames = Object.freeze([...new Set(Object.values(eventRoutes).flat())]);

export function isUuid(value) {
  return typeof value === 'string' && UUID.test(value);
}

export function validateEvent(event) {
  if (!event || !isUuid(event.id) || !isUuid(event.tenantId) ||
    typeof event.type !== 'string' || !Object.hasOwn(eventRoutes, event.type) || typeof event.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(event.occurredAt)) || !event.payload ||
    typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    throw new InvalidDelivery('invalid_event');
  }
  return event;
}

export class InvalidDelivery extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

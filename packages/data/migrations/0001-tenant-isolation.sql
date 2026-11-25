-- Applied in one transaction as eduapp_schema_migrator by src/migrate.mjs.
SET LOCAL search_path = pg_catalog;

SET LOCAL ROLE eduapp_tenancy_organization_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA tenancy_organization TO eduapp_tenancy_api;

CREATE TABLE tenancy_organization.tenants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL UNIQUE,
    status text NOT NULL,
    deleted_at timestamptz
);
ALTER TABLE tenancy_organization.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy_organization.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON tenancy_organization.tenants AS RESTRICTIVE
    USING (id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON tenancy_organization.tenants USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON tenancy_organization.tenants TO eduapp_tenancy_api;

CREATE TABLE tenancy_organization.org_units (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    parent_id uuid,
    kind text NOT NULL,
    code text NOT NULL,
    FOREIGN KEY (tenant_id) REFERENCES tenancy_organization.tenants (id),
    FOREIGN KEY (tenant_id, parent_id) REFERENCES tenancy_organization.org_units (tenant_id, id),
    UNIQUE NULLS NOT DISTINCT (tenant_id, parent_id, code),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE tenancy_organization.org_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy_organization.org_units FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON tenancy_organization.org_units AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON tenancy_organization.org_units USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON tenancy_organization.org_units TO eduapp_tenancy_api;
CREATE INDEX ON tenancy_organization.org_units (tenant_id, parent_id);

SET LOCAL ROLE eduapp_identity_access_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA identity_access TO eduapp_iam_api, eduapp_access_api;

CREATE TABLE identity_access.identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    login_normalized text NOT NULL UNIQUE,
    status text NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_access.identities TO eduapp_iam_api;

CREATE TABLE identity_access.sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    identity_id uuid NOT NULL REFERENCES identity_access.identities (id),
    refresh_hash text NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_access.sessions TO eduapp_iam_api;
CREATE INDEX ON identity_access.sessions (identity_id);

CREATE TABLE identity_access.memberships (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    identity_id uuid NOT NULL,
    org_unit_id uuid,
    status text NOT NULL,
    expires_at timestamptz,
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE identity_access.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_access.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON identity_access.memberships AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON identity_access.memberships USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_access.memberships TO eduapp_access_api;

CREATE TABLE identity_access.roles (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    name text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    UNIQUE (tenant_id, name, version),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE identity_access.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_access.roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON identity_access.roles AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON identity_access.roles USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_access.roles TO eduapp_access_api;

CREATE TABLE identity_access.role_bindings (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    membership_id uuid NOT NULL,
    role_id uuid NOT NULL,
    scope_org_id uuid,
    expires_at timestamptz,
    FOREIGN KEY (tenant_id, membership_id) REFERENCES identity_access.memberships (tenant_id, id),
    FOREIGN KEY (tenant_id, role_id) REFERENCES identity_access.roles (tenant_id, id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE identity_access.role_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_access.role_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON identity_access.role_bindings AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON identity_access.role_bindings USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_access.role_bindings TO eduapp_access_api;
CREATE INDEX ON identity_access.role_bindings (tenant_id, membership_id);
CREATE INDEX ON identity_access.role_bindings (tenant_id, role_id);

SET LOCAL ROLE eduapp_people_fields_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA people_fields TO eduapp_people_api, eduapp_fields_api;

CREATE TABLE people_fields.persons (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    identity_id uuid,
    display_name text NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE people_fields.persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE people_fields.persons FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON people_fields.persons AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON people_fields.persons USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON people_fields.persons TO eduapp_people_api;

CREATE TABLE people_fields.field_definitions (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    entity_type text NOT NULL,
    key text NOT NULL,
    schema_version integer NOT NULL CHECK (schema_version > 0),
    sensitivity text NOT NULL,
    UNIQUE (tenant_id, entity_type, key, schema_version),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE people_fields.field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE people_fields.field_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON people_fields.field_definitions AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON people_fields.field_definitions USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON people_fields.field_definitions TO eduapp_fields_api;

CREATE TABLE people_fields.field_values (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    entity_id uuid NOT NULL,
    definition_id uuid NOT NULL,
    value_jsonb jsonb NOT NULL,
    FOREIGN KEY (tenant_id, definition_id) REFERENCES people_fields.field_definitions (tenant_id, id),
    UNIQUE (tenant_id, entity_id, definition_id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE people_fields.field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE people_fields.field_values FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON people_fields.field_values AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON people_fields.field_values USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON people_fields.field_values TO eduapp_fields_api;
CREATE INDEX ON people_fields.field_values (tenant_id, definition_id);

SET LOCAL ROLE eduapp_commercial_billing_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA commercial_billing TO eduapp_billing_api;

CREATE TABLE commercial_billing.plans (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE
);
GRANT SELECT ON commercial_billing.plans TO eduapp_billing_api;

CREATE TABLE commercial_billing.plan_versions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_id uuid NOT NULL REFERENCES commercial_billing.plans (id),
    price_minor bigint NOT NULL CHECK (price_minor >= 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    effective_at timestamptz NOT NULL,
    UNIQUE (plan_id, effective_at)
);
GRANT SELECT ON commercial_billing.plan_versions TO eduapp_billing_api;

CREATE TABLE commercial_billing.entitlements (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    feature text NOT NULL,
    limit_value bigint CHECK (limit_value >= 0),
    valid_to timestamptz,
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE commercial_billing.entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing.entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON commercial_billing.entitlements AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON commercial_billing.entitlements USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON commercial_billing.entitlements TO eduapp_billing_api;
CREATE INDEX ON commercial_billing.entitlements (tenant_id, feature, valid_to);

CREATE TABLE commercial_billing.subscriptions (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    plan_version_id uuid NOT NULL REFERENCES commercial_billing.plan_versions (id),
    status text NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE commercial_billing.subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing.subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON commercial_billing.subscriptions AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON commercial_billing.subscriptions USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON commercial_billing.subscriptions TO eduapp_billing_api;
CREATE INDEX ON commercial_billing.subscriptions (plan_version_id);

CREATE TABLE commercial_billing.invoices (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    subscription_id uuid NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    status text NOT NULL,
    FOREIGN KEY (tenant_id, subscription_id) REFERENCES commercial_billing.subscriptions (tenant_id, id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE commercial_billing.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing.invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON commercial_billing.invoices AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON commercial_billing.invoices USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON commercial_billing.invoices TO eduapp_billing_api;
CREATE INDEX ON commercial_billing.invoices (tenant_id, subscription_id);

CREATE TABLE commercial_billing.payment_attempts (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    invoice_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    status text NOT NULL,
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES commercial_billing.invoices (tenant_id, id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE commercial_billing.payment_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing.payment_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON commercial_billing.payment_attempts AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON commercial_billing.payment_attempts USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON commercial_billing.payment_attempts TO eduapp_billing_api;
CREATE INDEX ON commercial_billing.payment_attempts (tenant_id, invoice_id);
CREATE UNIQUE INDEX ON commercial_billing.payment_attempts (tenant_id, idempotency_key);

CREATE TABLE commercial_billing.provider_events (
    provider text NOT NULL,
    provider_event_id text NOT NULL,
    payload_hash text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON commercial_billing.provider_events TO eduapp_billing_api;
CREATE UNIQUE INDEX ON commercial_billing.provider_events (provider, provider_event_id);

CREATE TABLE commercial_billing.ledger_entries (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    invoice_id uuid NOT NULL,
    direction text NOT NULL,
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES commercial_billing.invoices (tenant_id, id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE commercial_billing.ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing.ledger_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON commercial_billing.ledger_entries AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON commercial_billing.ledger_entries USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON commercial_billing.ledger_entries TO eduapp_billing_api;
CREATE INDEX ON commercial_billing.ledger_entries (tenant_id, invoice_id);

SET LOCAL ROLE eduapp_sites_content_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA sites_content TO eduapp_sites_api;

CREATE TABLE sites_content.sites (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    org_unit_id uuid NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE sites_content.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites_content.sites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON sites_content.sites AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON sites_content.sites USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON sites_content.sites TO eduapp_sites_api;

CREATE TABLE sites_content.domains (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    site_id uuid NOT NULL,
    host_normalized text NOT NULL CHECK (host_normalized = lower(host_normalized)),
    proof_status text NOT NULL,
    FOREIGN KEY (tenant_id, site_id) REFERENCES sites_content.sites (tenant_id, id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE sites_content.domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites_content.domains FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON sites_content.domains AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON sites_content.domains USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON sites_content.domains TO eduapp_sites_api;
CREATE INDEX ON sites_content.domains (tenant_id, site_id);
CREATE UNIQUE INDEX ON sites_content.domains (host_normalized) WHERE proof_status = 'verified';

CREATE TABLE sites_content.page_revisions (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    site_id uuid NOT NULL,
    schema_version integer NOT NULL CHECK (schema_version > 0),
    document_jsonb jsonb NOT NULL,
    published_at timestamptz,
    FOREIGN KEY (tenant_id, site_id) REFERENCES sites_content.sites (tenant_id, id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE sites_content.page_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites_content.page_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON sites_content.page_revisions AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON sites_content.page_revisions USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON sites_content.page_revisions TO eduapp_sites_api;
CREATE INDEX ON sites_content.page_revisions (tenant_id, site_id, published_at);

SET LOCAL ROLE eduapp_assets_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA assets TO eduapp_assets_api, eduapp_assets_worker;

CREATE TABLE assets.media_assets (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    object_key text NOT NULL,
    sha256 text NOT NULL,
    privacy text NOT NULL,
    scan_status text NOT NULL,
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    UNIQUE (tenant_id, object_key),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE assets.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets.media_assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON assets.media_assets AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON assets.media_assets USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON assets.media_assets TO eduapp_assets_api, eduapp_assets_worker;

CREATE TABLE assets.upload_sessions (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    expires_at timestamptz NOT NULL,
    status text NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE assets.upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets.upload_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON assets.upload_sessions AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON assets.upload_sessions USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON assets.upload_sessions TO eduapp_assets_api, eduapp_assets_worker;

SET LOCAL ROLE eduapp_school_enrollment_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA school_enrollment TO eduapp_school_api;

CREATE TABLE school_enrollment.schools (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    org_unit_id uuid NOT NULL,
    UNIQUE (tenant_id, org_unit_id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE school_enrollment.schools ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_enrollment.schools FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON school_enrollment.schools AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON school_enrollment.schools USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON school_enrollment.schools TO eduapp_school_api;

CREATE TABLE school_enrollment.academic_years (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    school_id uuid NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL CHECK (ends_on >= starts_on),
    FOREIGN KEY (tenant_id, school_id) REFERENCES school_enrollment.schools (tenant_id, id),
    UNIQUE (tenant_id, school_id, id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE school_enrollment.academic_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_enrollment.academic_years FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON school_enrollment.academic_years AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON school_enrollment.academic_years USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON school_enrollment.academic_years TO eduapp_school_api;

CREATE TABLE school_enrollment.class_groups (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    school_id uuid NOT NULL,
    year_id uuid NOT NULL,
    code text NOT NULL,
    FOREIGN KEY (tenant_id, school_id, year_id) REFERENCES school_enrollment.academic_years (tenant_id, school_id, id),
    UNIQUE (tenant_id, school_id, year_id, code),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE school_enrollment.class_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_enrollment.class_groups FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON school_enrollment.class_groups AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON school_enrollment.class_groups USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON school_enrollment.class_groups TO eduapp_school_api;
CREATE INDEX ON school_enrollment.class_groups (tenant_id, school_id, year_id);

CREATE TABLE school_enrollment.enrollments (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    school_id uuid NOT NULL,
    year_id uuid NOT NULL,
    student_person_id uuid NOT NULL,
    status text NOT NULL,
    FOREIGN KEY (tenant_id, school_id, year_id) REFERENCES school_enrollment.academic_years (tenant_id, school_id, id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE school_enrollment.enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_enrollment.enrollments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON school_enrollment.enrollments AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON school_enrollment.enrollments USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON school_enrollment.enrollments TO eduapp_school_api;
CREATE INDEX ON school_enrollment.enrollments (tenant_id, school_id, year_id, status);

CREATE TABLE school_enrollment.guardian_links (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    student_person_id uuid NOT NULL,
    guardian_person_id uuid NOT NULL,
    verified_at timestamptz,
    revoked_at timestamptz,
    UNIQUE (tenant_id, student_person_id, guardian_person_id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE school_enrollment.guardian_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_enrollment.guardian_links FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON school_enrollment.guardian_links AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON school_enrollment.guardian_links USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON school_enrollment.guardian_links TO eduapp_school_api;

SET LOCAL ROLE eduapp_attendance_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA attendance TO eduapp_attendance_api, eduapp_attendance_worker;

CREATE TABLE attendance.device_events (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    device_id uuid NOT NULL,
    external_event_id text NOT NULL,
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE attendance.device_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance.device_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON attendance.device_events AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON attendance.device_events USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON attendance.device_events TO eduapp_attendance_api, eduapp_attendance_worker;
CREATE UNIQUE INDEX ON attendance.device_events (tenant_id, device_id, external_event_id);

CREATE TABLE attendance.attendance_records (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    enrollment_id uuid NOT NULL,
    class_session_id uuid NOT NULL,
    status text NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE attendance.attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance.attendance_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON attendance.attendance_records AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON attendance.attendance_records USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON attendance.attendance_records TO eduapp_attendance_api, eduapp_attendance_worker;
CREATE UNIQUE INDEX ON attendance.attendance_records (tenant_id, enrollment_id, class_session_id);

CREATE TABLE attendance.attendance_revisions (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    record_id uuid NOT NULL,
    reason text NOT NULL,
    actor_id uuid NOT NULL,
    FOREIGN KEY (tenant_id, record_id) REFERENCES attendance.attendance_records (tenant_id, id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE attendance.attendance_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance.attendance_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON attendance.attendance_revisions AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON attendance.attendance_revisions USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON attendance.attendance_revisions TO eduapp_attendance_api, eduapp_attendance_worker;
CREATE INDEX ON attendance.attendance_revisions (tenant_id, record_id);

SET LOCAL ROLE eduapp_notifications_integrations_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA notifications_integrations TO eduapp_notifications_api, eduapp_notifications_worker;

CREATE TABLE notifications_integrations.message_jobs (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    logical_key text NOT NULL,
    recipient_ref text NOT NULL,
    status text NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE notifications_integrations.message_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_integrations.message_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON notifications_integrations.message_jobs AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON notifications_integrations.message_jobs USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications_integrations.message_jobs TO eduapp_notifications_api, eduapp_notifications_worker;
CREATE UNIQUE INDEX ON notifications_integrations.message_jobs (tenant_id, logical_key);

CREATE TABLE notifications_integrations.message_attempts (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    job_id uuid NOT NULL,
    provider text NOT NULL,
    external_ref text,
    status text NOT NULL,
    FOREIGN KEY (tenant_id, job_id) REFERENCES notifications_integrations.message_jobs (tenant_id, id),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE notifications_integrations.message_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications_integrations.message_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON notifications_integrations.message_attempts AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON notifications_integrations.message_attempts USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications_integrations.message_attempts TO eduapp_notifications_api, eduapp_notifications_worker;
CREATE INDEX ON notifications_integrations.message_attempts (tenant_id, job_id);

SET LOCAL ROLE eduapp_platform_audit_jobs_owner;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT USAGE ON SCHEMA platform_audit_jobs TO eduapp_platform_worker;

CREATE TABLE platform_audit_jobs.outbox_events (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL UNIQUE,
    event_type text NOT NULL,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE platform_audit_jobs.outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_jobs.outbox_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON platform_audit_jobs.outbox_events AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON platform_audit_jobs.outbox_events USING (true) WITH CHECK (true);
GRANT SELECT ON platform_audit_jobs.outbox_events TO eduapp_platform_worker;
GRANT UPDATE (published_at) ON platform_audit_jobs.outbox_events TO eduapp_platform_worker;
CREATE INDEX ON platform_audit_jobs.outbox_events (tenant_id, occurred_at, id) WHERE published_at IS NULL;

CREATE TABLE platform_audit_jobs.inbox_dedup (
    tenant_id uuid NOT NULL,
    consumer text NOT NULL,
    event_id uuid NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_audit_jobs.inbox_dedup ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_jobs.inbox_dedup FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON platform_audit_jobs.inbox_dedup AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON platform_audit_jobs.inbox_dedup USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON platform_audit_jobs.inbox_dedup TO eduapp_platform_worker;
CREATE UNIQUE INDEX ON platform_audit_jobs.inbox_dedup (tenant_id, consumer, event_id);
CREATE UNIQUE INDEX ON platform_audit_jobs.inbox_dedup (consumer, event_id);

CREATE TABLE platform_audit_jobs.audit_events (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    actor_id uuid,
    action text NOT NULL,
    resource_ref text NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, id)
);
ALTER TABLE platform_audit_jobs.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_jobs.audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON platform_audit_jobs.audit_events AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON platform_audit_jobs.audit_events USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON platform_audit_jobs.audit_events TO eduapp_platform_worker;

-- The current role remains subject to FORCE RLS. Only verified producer logins
-- may append their own approved event type for the transaction's bound tenant.
CREATE FUNCTION platform_audit_jobs.append_outbox(event_id uuid, topic text, event_payload jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    scoped_tenant uuid := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
BEGIN
    IF scoped_tenant IS NULL OR NOT EXISTS (
        SELECT 1 FROM (VALUES
            ('identity.session_revoked.v1', 'eduapp_iam_api'),
            ('tenancy.org_unit_changed.v1', 'eduapp_tenancy_api'),
            ('people.profile_changed.v1', 'eduapp_people_api'),
            ('fields.definition_published.v1', 'eduapp_fields_api'),
            ('billing.subscription_activated.v1', 'eduapp_billing_api'),
            ('sites.page_published.v1', 'eduapp_sites_api'),
            ('assets.asset_ready.v1', 'eduapp_assets_api'),
            ('assets.asset_ready.v1', 'eduapp_assets_worker'),
            ('school.enrollment_changed.v1', 'eduapp_school_api'),
            ('attendance.confirmed.v1', 'eduapp_attendance_api'),
            ('attendance.confirmed.v1', 'eduapp_attendance_worker'),
            ('notifications.delivery_updated.v1', 'eduapp_notifications_api'),
            ('notifications.delivery_updated.v1', 'eduapp_notifications_worker')
        ) AS producer(event_type, login_role)
        WHERE producer.event_type = topic AND producer.login_role = session_user::text
    ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Outbox producer or tenant is not authorized';
    END IF;

    INSERT INTO platform_audit_jobs.outbox_events (id, tenant_id, event_type, payload)
    VALUES (event_id, scoped_tenant, topic, event_payload);
    RETURN event_id;
END
$function$;
REVOKE ALL ON FUNCTION platform_audit_jobs.append_outbox(uuid, text, jsonb) FROM PUBLIC;
GRANT USAGE ON SCHEMA platform_audit_jobs TO eduapp_iam_api, eduapp_tenancy_api, eduapp_people_api, eduapp_fields_api, eduapp_billing_api, eduapp_sites_api, eduapp_assets_api, eduapp_assets_worker, eduapp_school_api, eduapp_attendance_api, eduapp_attendance_worker, eduapp_notifications_api, eduapp_notifications_worker;
GRANT EXECUTE ON FUNCTION platform_audit_jobs.append_outbox(uuid, text, jsonb) TO
    eduapp_iam_api, eduapp_tenancy_api, eduapp_people_api, eduapp_fields_api, eduapp_billing_api, eduapp_sites_api, eduapp_assets_api, eduapp_assets_worker, eduapp_school_api, eduapp_attendance_api, eduapp_attendance_worker, eduapp_notifications_api, eduapp_notifications_worker;

RESET ROLE;

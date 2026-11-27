SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_tenancy_organization_owner;

ALTER TABLE tenancy_organization.tenants
    ADD COLUMN display_name text,
    ADD COLUMN owner_identity_id uuid,
    ADD COLUMN owner_membership_id uuid,
    ADD COLUMN trial_ends_at timestamptz,
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    ADD COLUMN updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    ADD CONSTRAINT registry_managed_shape CHECK (
        display_name IS NULL OR (
            char_length(display_name) BETWEEN 1 AND 160
            AND owner_identity_id IS NOT NULL
            AND status IN ('active', 'suspended')
            AND slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'
            AND (trial_ends_at IS NULL OR trial_ends_at > created_at)
        )
    );

REVOKE UPDATE, DELETE ON tenancy_organization.tenants FROM eduapp_tenancy_api;
GRANT UPDATE (owner_membership_id, status, version, updated_at)
    ON tenancy_organization.tenants TO eduapp_tenancy_api;

CREATE TABLE tenancy_organization.legal_entities (
    tenant_id uuid PRIMARY KEY REFERENCES tenancy_organization.tenants (id),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
    country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    registration_number text NOT NULL CHECK (char_length(registration_number) BETWEEN 1 AND 64)
);

CREATE TABLE tenancy_organization.registry_create_commands (
    tenant_id uuid PRIMARY KEY,
    actor_id uuid NOT NULL,
    fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
    proof_kind text NOT NULL CHECK (proof_kind IN ('platform_admin', 'verified_payment')),
    payment_reference_digest text UNIQUE CHECK (payment_reference_digest ~ '^[0-9a-f]{64}$'),
    result jsonb CHECK (jsonb_typeof(result) = 'object'),
    CHECK ((proof_kind = 'verified_payment') = (payment_reference_digest IS NOT NULL))
);

CREATE TABLE tenancy_organization.registry_audit_facts (
    tenant_id uuid NOT NULL REFERENCES tenancy_organization.tenants (id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    actor_id uuid NOT NULL,
    request_id uuid NOT NULL,
    action text NOT NULL CHECK (action IN ('tenant_created', 'tenant_suspended', 'tenant_reactivated')),
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, id)
);

DO $policies$
DECLARE
    relation text;
    grants text;
BEGIN
    FOR relation, grants IN SELECT * FROM (VALUES
        ('legal_entities', 'SELECT, INSERT'),
        ('registry_create_commands', 'SELECT, INSERT'),
        ('registry_audit_facts', 'SELECT, INSERT')
    ) AS settings(relation, grants)
    LOOP
        EXECUTE format('ALTER TABLE tenancy_organization.%I ENABLE ROW LEVEL SECURITY', relation);
        EXECUTE format('ALTER TABLE tenancy_organization.%I FORCE ROW LEVEL SECURITY', relation);
        EXECUTE format(
            $query$CREATE POLICY tenant_guard ON tenancy_organization.%I AS RESTRICTIVE
            USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)$query$,
            relation
        );
        EXECUTE format('CREATE POLICY granted_operation ON tenancy_organization.%I USING (true) WITH CHECK (true)', relation);
        EXECUTE format('GRANT %s ON tenancy_organization.%I TO eduapp_tenancy_api', grants, relation);
    END LOOP;
END
$policies$;
GRANT UPDATE (result) ON tenancy_organization.registry_create_commands TO eduapp_tenancy_api;

CREATE FUNCTION tenancy_organization.pending_registry_owner(owner_identity uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT EXISTS (
        SELECT FROM tenancy_organization.tenants AS t
        JOIN tenancy_organization.registry_create_commands AS c ON c.tenant_id = t.id
        WHERE t.id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid
          AND t.display_name IS NOT NULL AND t.owner_identity_id = owner_identity
          AND t.owner_membership_id IS NULL AND t.status = 'active' AND t.deleted_at IS NULL
          AND c.result IS NULL
    )
$$;
REVOKE ALL ON FUNCTION tenancy_organization.pending_registry_owner(uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA tenancy_organization TO eduapp_identity_access_owner;
GRANT EXECUTE ON FUNCTION tenancy_organization.pending_registry_owner(uuid) TO eduapp_identity_access_owner;

CREATE FUNCTION tenancy_organization.registry_event_allowed()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT EXISTS (
        SELECT FROM tenancy_organization.tenants AS t
        JOIN tenancy_organization.registry_create_commands AS c ON c.tenant_id = t.id
        WHERE t.id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid
          AND t.display_name IS NOT NULL AND t.owner_membership_id IS NOT NULL AND c.result IS NULL
    )
$$;
REVOKE ALL ON FUNCTION tenancy_organization.registry_event_allowed() FROM PUBLIC;
GRANT USAGE ON SCHEMA tenancy_organization TO eduapp_platform_audit_jobs_owner;
GRANT EXECUTE ON FUNCTION tenancy_organization.registry_event_allowed() TO eduapp_platform_audit_jobs_owner;

SET LOCAL ROLE eduapp_identity_access_owner;

CREATE TABLE identity_access.registry_owner_receipts (
    tenant_id uuid PRIMARY KEY,
    membership_id uuid NOT NULL,
    FOREIGN KEY (tenant_id, membership_id) REFERENCES identity_access.memberships (tenant_id, id)
);
ALTER TABLE identity_access.registry_owner_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_access.registry_owner_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON identity_access.registry_owner_receipts AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON identity_access.registry_owner_receipts USING (true) WITH CHECK (true);

CREATE FUNCTION identity_access.bootstrap_registry_owner(owner_identity uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    bound_tenant uuid := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
    owner_membership uuid;
    owner_role uuid;
BEGIN
    IF bound_tenant IS NULL OR session_user::text <> 'eduapp_tenancy_api'
        OR NOT tenancy_organization.pending_registry_owner(owner_identity) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Registry owner handoff is not authorized';
    END IF;

    PERFORM 1 FROM identity_access.identities WHERE id = owner_identity AND status = 'active' FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'An active owner identity is required';
    END IF;
    IF EXISTS (SELECT FROM identity_access.memberships WHERE tenant_id = bound_tenant) THEN
        RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'Tenant bootstrap already exists';
    END IF;

    INSERT INTO identity_access.memberships (tenant_id, identity_id, status)
    VALUES (bound_tenant, owner_identity, 'active') RETURNING id INTO owner_membership;
    INSERT INTO identity_access.roles (tenant_id, name, version, builtin, rules)
    VALUES (bound_tenant, 'Tenant owner', 1, true, '[
        {"action":"tenancy.tenant.read","effect":"allow","relationship":null,"fields":[]},
        {"action":"tenancy.org.read","effect":"allow","relationship":null,"fields":[]},
        {"action":"tenancy.org.write","effect":"allow","relationship":null,"fields":[]}
    ]'::jsonb) RETURNING id INTO owner_role;
    INSERT INTO identity_access.role_bindings (tenant_id, membership_id, role_id)
    VALUES (bound_tenant, owner_membership, owner_role);
    INSERT INTO identity_access.registry_owner_receipts (tenant_id, membership_id)
    VALUES (bound_tenant, owner_membership);
    RETURN owner_membership;
END
$function$;
REVOKE ALL ON FUNCTION identity_access.bootstrap_registry_owner(uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA identity_access TO eduapp_tenancy_api;
GRANT EXECUTE ON FUNCTION identity_access.bootstrap_registry_owner(uuid) TO eduapp_tenancy_api;

SET LOCAL ROLE eduapp_platform_audit_jobs_owner;

CREATE FUNCTION platform_audit_jobs.append_registry_created()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    bound_tenant uuid := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
BEGIN
    IF bound_tenant IS NULL OR session_user::text <> 'eduapp_tenancy_api'
        OR NOT tenancy_organization.registry_event_allowed() THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Registry event is not authorized';
    END IF;
    INSERT INTO platform_audit_jobs.outbox_events (id, tenant_id, event_type, payload)
    VALUES (bound_tenant, bound_tenant, 'tenancy.tenant_created.v1', jsonb_build_object('tenantId', bound_tenant));
END
$function$;
REVOKE ALL ON FUNCTION platform_audit_jobs.append_registry_created() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_audit_jobs.append_registry_created() TO eduapp_tenancy_api;

RESET ROLE;

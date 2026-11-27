SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_tenancy_organization_owner;

ALTER TABLE tenancy_organization.org_units
    ADD COLUMN name text,
    ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0),
    ADD CONSTRAINT org_units_name_length CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 120);

CREATE TABLE tenancy_organization.org_unit_create_requests (
    tenant_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    key_digest bytea NOT NULL CHECK (octet_length(key_digest) = 32),
    fingerprint bytea NOT NULL CHECK (octet_length(fingerprint) = 32),
    org_unit_id uuid NOT NULL,
    response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
    PRIMARY KEY (tenant_id, actor_id, key_digest),
    FOREIGN KEY (tenant_id, org_unit_id) REFERENCES tenancy_organization.org_units (tenant_id, id)
);
ALTER TABLE tenancy_organization.org_unit_create_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy_organization.org_unit_create_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON tenancy_organization.org_unit_create_requests AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON tenancy_organization.org_unit_create_requests USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON tenancy_organization.org_unit_create_requests TO eduapp_tenancy_api;

RESET ROLE;

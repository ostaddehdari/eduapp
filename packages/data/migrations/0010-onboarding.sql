SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_tenancy_organization_owner;

CREATE TABLE tenancy_organization.onboarding_progress (
    tenant_id uuid PRIMARY KEY REFERENCES tenancy_organization.tenants (id),
    version integer NOT NULL DEFAULT 0 CHECK (version BETWEEN 0 AND 4),
    draft jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(draft) = 'object'),
    claim_id uuid,
    claimed_until timestamptz,
    claim_fingerprint text CHECK (claim_fingerprint ~ '^[0-9a-f]{64}$'),
    CHECK ((claim_id IS NULL AND claimed_until IS NULL AND claim_fingerprint IS NULL)
        OR (claim_id IS NOT NULL AND claimed_until IS NOT NULL AND claim_fingerprint IS NOT NULL))
);
ALTER TABLE tenancy_organization.onboarding_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy_organization.onboarding_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON tenancy_organization.onboarding_progress AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON tenancy_organization.onboarding_progress USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON tenancy_organization.onboarding_progress TO eduapp_tenancy_api;

SET LOCAL ROLE eduapp_sites_content_owner;
ALTER TABLE sites_content.sites
    ADD COLUMN draft_name text,
    ADD COLUMN draft_slug text,
    ADD CONSTRAINT site_draft_fields CHECK (
        (draft_name IS NULL AND draft_slug IS NULL)
        OR (draft_name IS NOT NULL AND draft_slug IS NOT NULL
            AND char_length(draft_name) BETWEEN 1 AND 120
            AND char_length(draft_slug) BETWEEN 1 AND 64
            AND draft_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
    );
CREATE UNIQUE INDEX onboarding_site_slug ON sites_content.sites (tenant_id, draft_slug)
    WHERE draft_slug IS NOT NULL;
RESET ROLE;

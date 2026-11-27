SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_tenancy_organization_owner;

CREATE TABLE tenancy_organization.org_unit_move_history (
    tenant_id uuid NOT NULL,
    org_unit_id uuid NOT NULL,
    prior_version integer NOT NULL CHECK (prior_version > 0),
    version integer NOT NULL CHECK (version = prior_version + 1),
    prior_parent_id uuid,
    parent_id uuid,
    actor_id uuid NOT NULL,
    request_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (tenant_id, org_unit_id, version),
    FOREIGN KEY (tenant_id, org_unit_id) REFERENCES tenancy_organization.org_units (tenant_id, id),
    FOREIGN KEY (tenant_id, prior_parent_id) REFERENCES tenancy_organization.org_units (tenant_id, id),
    FOREIGN KEY (tenant_id, parent_id) REFERENCES tenancy_organization.org_units (tenant_id, id),
    CHECK (prior_parent_id IS DISTINCT FROM parent_id)
);
ALTER TABLE tenancy_organization.org_unit_move_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy_organization.org_unit_move_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON tenancy_organization.org_unit_move_history AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON tenancy_organization.org_unit_move_history USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON tenancy_organization.org_unit_move_history TO eduapp_tenancy_api;

-- Access calls this owned predicate from its invitation transaction. Row locks
-- keep suspension or removal from racing the membership write.
CREATE FUNCTION tenancy_organization.invitation_scope_live(target_org_unit uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    scoped_tenant uuid := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
BEGIN
    IF scoped_tenant IS NULL OR session_user::text <> 'eduapp_access_api' THEN
        RETURN false;
    END IF;
    PERFORM 1 FROM tenancy_organization.tenants
    WHERE id = scoped_tenant AND status = 'active' AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    IF target_org_unit IS NULL THEN
        RETURN true;
    END IF;
    PERFORM 1 FROM tenancy_organization.org_units
    WHERE tenant_id = scoped_tenant AND id = target_org_unit FOR SHARE;
    RETURN FOUND;
END
$function$;
REVOKE ALL ON FUNCTION tenancy_organization.invitation_scope_live(uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA tenancy_organization TO eduapp_access_api;
GRANT EXECUTE ON FUNCTION tenancy_organization.invitation_scope_live(uuid) TO eduapp_access_api;

SET LOCAL ROLE eduapp_identity_access_owner;

GRANT SELECT (tenant_id, membership_id) ON identity_access.registry_owner_receipts TO eduapp_access_api;

ALTER TABLE identity_access.invitations
    ADD COLUMN request_key uuid,
    ADD COLUMN delivered_at timestamptz;

-- Existing outstanding invitations were issued under the earlier eager-delivery contract.
-- FORCE RLS still applies to the owner, so backfill via a migration-local one-way policy.
ALTER POLICY tenant_guard ON identity_access.invitations
    USING (current_user = 'eduapp_identity_access_owner'
        OR tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (current_user = 'eduapp_identity_access_owner'
        OR tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
UPDATE identity_access.invitations SET delivered_at = created_at WHERE revoked_at IS NULL;
ALTER POLICY tenant_guard ON identity_access.invitations
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
ALTER TABLE identity_access.invitations
    ADD CONSTRAINT invitations_lifetime_limit CHECK (expires_at <= created_at + interval '168 hours') NOT VALID;

CREATE UNIQUE INDEX invitations_request_key
ON identity_access.invitations (tenant_id, invited_by_membership_id, request_key) WHERE request_key IS NOT NULL;
GRANT UPDATE (delivered_at) ON identity_access.invitations TO eduapp_access_api;

RESET ROLE;

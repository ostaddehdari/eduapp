SET LOCAL search_path = pg_catalog;

SET LOCAL ROLE eduapp_identity_access_owner;

CREATE UNIQUE INDEX memberships_one_active_scope
ON identity_access.memberships (tenant_id, identity_id, org_unit_id) NULLS NOT DISTINCT
WHERE status = 'active';

CREATE INDEX memberships_active_identity_lookup
ON identity_access.memberships (tenant_id, identity_id, id) WHERE status = 'active';

CREATE TABLE identity_access.invitations (
    tenant_id uuid NOT NULL,
    id uuid NOT NULL,
    identity_id uuid NOT NULL,
    org_unit_id uuid,
    invited_by_membership_id uuid NOT NULL,
    token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    expires_at timestamptz NOT NULL DEFAULT statement_timestamp() + interval '48 hours',
    accepted_at timestamptz,
    accepted_membership_id uuid,
    revoked_at timestamptz,
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, token_hash),
    FOREIGN KEY (tenant_id, invited_by_membership_id) REFERENCES identity_access.memberships (tenant_id, id),
    FOREIGN KEY (tenant_id, accepted_membership_id) REFERENCES identity_access.memberships (tenant_id, id),
    CHECK (expires_at > created_at),
    CHECK ((accepted_at IS NULL) = (accepted_membership_id IS NULL)),
    CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
ALTER TABLE identity_access.invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity_access.invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON identity_access.invitations AS RESTRICTIVE
    USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
    WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON identity_access.invitations USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON identity_access.invitations TO eduapp_access_api;
GRANT UPDATE (accepted_at, accepted_membership_id, revoked_at) ON identity_access.invitations TO eduapp_access_api;
CREATE INDEX invitations_inviter_lookup ON identity_access.invitations (tenant_id, invited_by_membership_id);
CREATE INDEX invitations_accepted_membership_lookup ON identity_access.invitations (tenant_id, accepted_membership_id)
WHERE accepted_membership_id IS NOT NULL;

SET LOCAL ROLE eduapp_people_fields_owner;
CREATE UNIQUE INDEX persons_one_linked_identity
ON people_fields.persons (tenant_id, identity_id) WHERE identity_id IS NOT NULL;

RESET ROLE;

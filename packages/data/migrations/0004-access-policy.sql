SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_identity_access_owner;

ALTER TABLE identity_access.roles
    ADD COLUMN rules jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN builtin boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT roles_rules_array CHECK (
        CASE WHEN jsonb_typeof(rules) = 'array' THEN jsonb_array_length(rules) <= 64 ELSE false END
    );

CREATE INDEX roles_bindings_membership_lookup
ON identity_access.role_bindings (tenant_id, membership_id, role_id);

RESET ROLE;

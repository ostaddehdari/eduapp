SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_tenancy_organization_owner;

CREATE TABLE tenancy_organization.management_status_requests (
    tenant_id uuid NOT NULL REFERENCES tenancy_organization.tenants (id),
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    target_status text NOT NULL CHECK (target_status IN ('active', 'suspended')),
    expected_version integer NOT NULL CHECK (expected_version > 0),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'rejected', 'stale')),
    requested_by uuid NOT NULL,
    requested_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    decided_by uuid,
    decided_at timestamptz,
    result_version integer CHECK (result_version > 0),
    PRIMARY KEY (tenant_id, id),
    CHECK (decided_by IS NULL OR decided_by <> requested_by),
    CHECK ((state = 'pending' AND decided_by IS NULL AND decided_at IS NULL AND result_version IS NULL) OR
           (state <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND result_version IS NOT NULL)),
    CHECK (decided_at IS NULL OR decided_at >= requested_at)
);
CREATE UNIQUE INDEX management_one_pending_status_request
ON tenancy_organization.management_status_requests (tenant_id) WHERE state = 'pending';
CREATE INDEX management_status_requests_timeline
ON tenancy_organization.management_status_requests (tenant_id, requested_at DESC, id);

CREATE TABLE tenancy_organization.management_status_audit (
    tenant_id uuid NOT NULL,
    approval_id uuid NOT NULL,
    request_id uuid NOT NULL,
    actor_id uuid NOT NULL,
    requester_id uuid NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('requested', 'approved', 'rejected', 'stale')),
    result_version integer NOT NULL CHECK (result_version > 0),
    occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    PRIMARY KEY (tenant_id, approval_id, outcome),
    FOREIGN KEY (tenant_id, approval_id) REFERENCES tenancy_organization.management_status_requests (tenant_id, id),
    CHECK ((outcome = 'requested') = (actor_id = requester_id))
);

DO $management_policies$
DECLARE
    relation text;
BEGIN
    FOREACH relation IN ARRAY ARRAY['management_status_requests', 'management_status_audit']
    LOOP
        EXECUTE format('ALTER TABLE tenancy_organization.%I ENABLE ROW LEVEL SECURITY', relation);
        EXECUTE format('ALTER TABLE tenancy_organization.%I FORCE ROW LEVEL SECURITY', relation);
        EXECUTE format(
            $policy$CREATE POLICY tenant_guard ON tenancy_organization.%I AS RESTRICTIVE
            USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
            WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)$policy$,
            relation
        );
        EXECUTE format('CREATE POLICY granted_operation ON tenancy_organization.%I USING (true) WITH CHECK (true)', relation);
    END LOOP;
END
$management_policies$;

GRANT SELECT ON tenancy_organization.management_status_requests TO eduapp_tenancy_api;
GRANT INSERT (tenant_id, target_status, expected_version, requested_by)
ON tenancy_organization.management_status_requests TO eduapp_tenancy_api;
GRANT UPDATE (state, decided_by, decided_at, result_version)
ON tenancy_organization.management_status_requests TO eduapp_tenancy_api;
GRANT INSERT ON tenancy_organization.management_status_audit TO eduapp_tenancy_api;

RESET ROLE;

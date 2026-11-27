SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_identity_access_owner;

CREATE TABLE identity_access.security_login_facts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id uuid,
    request_id uuid,
    tenant_id uuid,
    membership_id uuid,
    session_id uuid,
    outcome text NOT NULL CHECK (outcome IN ('success', 'denied', 'error')),
    occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    CHECK (outcome <> 'success' OR actor_id IS NOT NULL),
    CHECK ((tenant_id IS NULL) = (membership_id IS NULL)),
    CHECK (outcome = 'success' OR (tenant_id IS NULL AND session_id IS NULL))
);
GRANT INSERT (actor_id, request_id, tenant_id, membership_id, session_id, outcome)
    ON identity_access.security_login_facts TO eduapp_iam_api;

-- A successful check locks the current membership through the audit commit.
CREATE FUNCTION identity_access.assert_security_membership(actor uuid, membership uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
BEGIN
    PERFORM 1 FROM identity_access.memberships
    WHERE tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid
      AND id = membership AND identity_id = actor AND status = 'active'
      AND (expires_at IS NULL OR expires_at > statement_timestamp())
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Security audit context is not authorized';
    END IF;
END
$function$;
REVOKE ALL ON FUNCTION identity_access.assert_security_membership(uuid, uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA identity_access TO eduapp_platform_audit_jobs_owner;
GRANT EXECUTE ON FUNCTION identity_access.assert_security_membership(uuid, uuid) TO eduapp_platform_audit_jobs_owner;

SET LOCAL ROLE eduapp_platform_audit_jobs_owner;

ALTER TABLE platform_audit_jobs.audit_events
    ADD COLUMN membership_id uuid,
    ADD COLUMN request_id uuid,
    ADD COLUMN outcome text,
    ADD CONSTRAINT audit_security_shape CHECK (
        action NOT LIKE 'security.%'
        OR (
            actor_id IS NOT NULL AND membership_id IS NOT NULL AND outcome IS NOT NULL
            AND outcome IN ('success', 'denied')
            AND resource_ref ~ '^(scope|[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$'
        )
    );

CREATE POLICY security_audit_writer ON platform_audit_jobs.audit_events AS RESTRICTIVE FOR INSERT
    WITH CHECK (action NOT LIKE 'security.%' OR current_user = 'eduapp_platform_audit_jobs_owner');

CREATE INDEX security_audit_request_lookup ON platform_audit_jobs.audit_events (tenant_id, request_id)
    WHERE request_id IS NOT NULL AND action LIKE 'security.%';

-- The function is owned by Platform. It never accepts a tenant as an argument.
CREATE FUNCTION platform_audit_jobs.append_security_audit(
    event_type text, actor uuid, membership uuid, request_ref uuid, resource_id uuid, result text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    scoped_tenant uuid := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
BEGIN
    IF scoped_tenant IS NULL OR actor IS NULL OR membership IS NULL
        OR result IS NULL OR result NOT IN ('success', 'denied')
        OR (result = 'denied' AND resource_id IS NOT NULL)
        OR NOT EXISTS (
            SELECT 1 FROM (VALUES
                ('security.role_created.v1', 'eduapp_access_api', true),
                ('security.role_updated.v1', 'eduapp_access_api', true),
                ('security.role_assigned.v1', 'eduapp_access_api', true),
                ('security.membership_delegated.v1', 'eduapp_access_api', true),
                ('security.invitation_delegated.v1', 'eduapp_access_api', true),
                ('security.sensitive_access.v1', 'eduapp_access_api', false),
                ('security.sensitive_access.v1', 'eduapp_people_api', false)
            ) AS producer(action, login_role, needs_resource)
            WHERE producer.action = event_type AND producer.login_role = session_user::text
              AND (result <> 'success' OR NOT producer.needs_resource OR resource_id IS NOT NULL)
        ) THEN
        RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Security audit producer or context is not authorized';
    END IF;

    PERFORM identity_access.assert_security_membership(actor, membership);
    INSERT INTO platform_audit_jobs.audit_events (tenant_id, actor_id, membership_id, request_id, action, resource_ref, outcome)
    VALUES (scoped_tenant, actor, membership, request_ref, event_type, COALESCE(resource_id::text, 'scope'), result);
END
$function$;
REVOKE ALL ON FUNCTION platform_audit_jobs.append_security_audit(text, uuid, uuid, uuid, uuid, text) FROM PUBLIC;
GRANT USAGE ON SCHEMA platform_audit_jobs TO eduapp_access_api;
GRANT EXECUTE ON FUNCTION platform_audit_jobs.append_security_audit(text, uuid, uuid, uuid, uuid, text)
    TO eduapp_access_api, eduapp_people_api;

RESET ROLE;

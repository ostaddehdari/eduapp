-- Apply once as a provisioning administrator in a dedicated EduApp database.
-- Usage: psql "$ADMIN_URL" -X -v ON_ERROR_STOP=1 --single-transaction -f bootstrap.sql
DO $bootstrap$
DECLARE
    spec record;
    existing pg_catalog.pg_roles%ROWTYPE;
    namespace_owner name;
BEGIN
    FOR spec IN
        SELECT * FROM (VALUES
            ('eduapp_schema_migrator', true),
            ('eduapp_tenancy_organization_owner', false),
            ('eduapp_identity_access_owner', false),
            ('eduapp_people_fields_owner', false),
            ('eduapp_commercial_billing_owner', false),
            ('eduapp_sites_content_owner', false),
            ('eduapp_assets_owner', false),
            ('eduapp_school_enrollment_owner', false),
            ('eduapp_attendance_owner', false),
            ('eduapp_notifications_integrations_owner', false),
            ('eduapp_platform_audit_jobs_owner', false),
            ('eduapp_tenancy_api', true),
            ('eduapp_iam_api', true),
            ('eduapp_people_api', true),
            ('eduapp_access_api', true),
            ('eduapp_fields_api', true),
            ('eduapp_billing_api', true),
            ('eduapp_sites_api', true),
            ('eduapp_assets_api', true),
            ('eduapp_assets_worker', true),
            ('eduapp_school_api', true),
            ('eduapp_attendance_api', true),
            ('eduapp_attendance_worker', true),
            ('eduapp_notifications_api', true),
            ('eduapp_notifications_worker', true),
            ('eduapp_platform_worker', true)
        ) AS roles(role_name, can_login)
    LOOP
        SELECT * INTO existing FROM pg_catalog.pg_roles WHERE rolname = spec.role_name;
        IF NOT FOUND THEN
            EXECUTE format(
                'CREATE ROLE %I %s NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION NOBYPASSRLS',
                spec.role_name, CASE WHEN spec.can_login THEN 'LOGIN' ELSE 'NOLOGIN' END
            );
        ELSIF existing.rolcanlogin <> spec.can_login OR existing.rolsuper
            OR existing.rolcreaterole OR existing.rolcreatedb OR existing.rolreplication
            OR existing.rolinherit OR existing.rolbypassrls THEN
            RAISE EXCEPTION 'Existing EduApp role has unexpected attributes: %', spec.role_name;
        END IF;

        IF spec.role_name <> 'eduapp_schema_migrator' AND EXISTS (
            SELECT 1 FROM pg_catalog.pg_auth_members AS memberships
            JOIN pg_catalog.pg_roles AS member ON member.oid = memberships.member
            WHERE member.rolname = spec.role_name
        ) THEN
            RAISE EXCEPTION 'Unexpected role membership for %', spec.role_name;
        END IF;

        IF spec.can_login THEN
            EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), spec.role_name);
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_auth_members AS memberships
        JOIN pg_catalog.pg_roles AS member ON member.oid = memberships.member
        JOIN pg_catalog.pg_roles AS parent ON parent.oid = memberships.roleid
        WHERE member.rolname = 'eduapp_schema_migrator'
          AND (parent.rolname NOT IN (
              'eduapp_tenancy_organization_owner',
              'eduapp_identity_access_owner',
              'eduapp_people_fields_owner',
              'eduapp_commercial_billing_owner',
              'eduapp_sites_content_owner',
              'eduapp_assets_owner',
              'eduapp_school_enrollment_owner',
              'eduapp_attendance_owner',
              'eduapp_notifications_integrations_owner',
              'eduapp_platform_audit_jobs_owner'
            ) OR memberships.admin_option OR memberships.inherit_option OR NOT memberships.set_option)
    ) THEN
        RAISE EXCEPTION 'Unexpected schema migrator role membership';
    END IF;

    EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
    REVOKE ALL ON SCHEMA public FROM PUBLIC;

    FOR spec IN
        SELECT * FROM (VALUES
            ('tenancy_organization', 'eduapp_tenancy_organization_owner'),
            ('identity_access', 'eduapp_identity_access_owner'),
            ('people_fields', 'eduapp_people_fields_owner'),
            ('commercial_billing', 'eduapp_commercial_billing_owner'),
            ('sites_content', 'eduapp_sites_content_owner'),
            ('assets', 'eduapp_assets_owner'),
            ('school_enrollment', 'eduapp_school_enrollment_owner'),
            ('attendance', 'eduapp_attendance_owner'),
            ('notifications_integrations', 'eduapp_notifications_integrations_owner'),
            ('platform_audit_jobs', 'eduapp_platform_audit_jobs_owner'),
            ('eduapp_migrations', 'eduapp_schema_migrator')
        ) AS schemas(schema_name, owner_name)
    LOOP
        SELECT pg_catalog.pg_get_userbyid(nspowner) INTO namespace_owner
        FROM pg_catalog.pg_namespace WHERE nspname = spec.schema_name;
        IF NOT FOUND THEN
            EXECUTE format('CREATE SCHEMA %I AUTHORIZATION %I', spec.schema_name, spec.owner_name);
        ELSIF namespace_owner <> spec.owner_name THEN
            RAISE EXCEPTION 'Unexpected schema owner for %', spec.schema_name;
        END IF;
        IF spec.schema_name <> 'eduapp_migrations' THEN
            EXECUTE format(
                'GRANT %I TO eduapp_schema_migrator WITH ADMIN FALSE, INHERIT FALSE, SET TRUE',
                spec.owner_name
            );
        END IF;
    END LOOP;
END
$bootstrap$;

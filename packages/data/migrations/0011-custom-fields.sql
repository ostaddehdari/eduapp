SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_people_fields_owner;

ALTER TABLE people_fields.field_definitions
    ADD COLUMN label text CHECK (char_length(label) BETWEEN 1 AND 100),
    ADD COLUMN data_type text CHECK (data_type IN ('text', 'integer', 'boolean', 'date', 'choice')),
    ADD COLUMN constraints_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(constraints_json) = 'object'),
    ADD COLUMN required boolean NOT NULL DEFAULT false,
    ADD COLUMN created_by uuid,
    ADD COLUMN request_id uuid,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    ADD CONSTRAINT managed_field_definition_shape CHECK (
        data_type IS NULL OR (
            entity_type IN ('school', 'student') AND sensitivity = 'standard'
            AND label IS NOT NULL AND created_by IS NOT NULL AND request_id IS NOT NULL
            AND char_length(key) BETWEEN 2 AND 48 AND key ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'
        )
    );

ALTER TABLE people_fields.field_values
    ADD COLUMN school_id uuid,
    ADD COLUMN value_version integer NOT NULL DEFAULT 1 CHECK (value_version > 0),
    ADD COLUMN created_by uuid,
    ADD COLUMN request_id uuid,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
    ADD CONSTRAINT managed_field_value_provenance CHECK (
        school_id IS NULL OR (created_by IS NOT NULL AND request_id IS NOT NULL)
    ),
    DROP CONSTRAINT field_values_tenant_id_entity_id_definition_id_key,
    ADD CONSTRAINT field_values_school_revision_key
        UNIQUE NULLS NOT DISTINCT (tenant_id, school_id, entity_id, definition_id, value_version);

CREATE INDEX field_values_school_history
ON people_fields.field_values (tenant_id, school_id, entity_id, id) WHERE school_id IS NOT NULL;

REVOKE UPDATE, DELETE ON people_fields.field_definitions, people_fields.field_values FROM eduapp_fields_api;

SET LOCAL ROLE eduapp_tenancy_organization_owner;

CREATE FUNCTION tenancy_organization.custom_fields_tenant_active(target_org_unit uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    bound_tenant uuid := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
BEGIN
    IF bound_tenant IS NULL OR session_user::text <> 'eduapp_fields_api' THEN
        RETURN false;
    END IF;
    PERFORM 1 FROM tenancy_organization.tenants
    WHERE id = bound_tenant AND status = 'active' AND deleted_at IS NULL FOR SHARE;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    IF target_org_unit IS NULL THEN
        RETURN true;
    END IF;
    PERFORM 1 FROM tenancy_organization.org_units
    WHERE tenant_id = bound_tenant AND id = target_org_unit FOR SHARE;
    RETURN FOUND;
END
$function$;
REVOKE ALL ON FUNCTION tenancy_organization.custom_fields_tenant_active(uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA tenancy_organization TO eduapp_fields_api;
GRANT EXECUTE ON FUNCTION tenancy_organization.custom_fields_tenant_active(uuid) TO eduapp_fields_api;

SET LOCAL ROLE eduapp_school_enrollment_owner;

CREATE INDEX custom_fields_active_student_school_lookup
ON school_enrollment.enrollments (tenant_id, school_id, student_person_id) WHERE status = 'active';

-- Resolve only authorized application lookup scope, never a student profile.
CREATE FUNCTION school_enrollment.custom_fields_resource_scope(resource_kind text, school_ref uuid, entity_ref uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
    bound_tenant uuid := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
    org_ref uuid;
BEGIN
    IF bound_tenant IS NULL OR session_user::text <> 'eduapp_fields_api'
        OR resource_kind IS NULL OR resource_kind NOT IN ('school', 'student') OR school_ref IS NULL OR entity_ref IS NULL
        OR (resource_kind = 'school' AND school_ref <> entity_ref) THEN
        RETURN NULL;
    END IF;

    SELECT school.org_unit_id INTO org_ref FROM school_enrollment.schools AS school
    WHERE school.tenant_id = bound_tenant AND school.id = school_ref FOR SHARE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF resource_kind = 'student' THEN
        PERFORM 1 FROM school_enrollment.enrollments e
        WHERE e.tenant_id = bound_tenant AND e.school_id = school_ref AND e.student_person_id = entity_ref
          AND status = 'active' LIMIT 1 FOR SHARE;
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;
    END IF;
    RETURN org_ref;
END
$function$;
REVOKE ALL ON FUNCTION school_enrollment.custom_fields_resource_scope(text, uuid, uuid) FROM PUBLIC;
GRANT USAGE ON SCHEMA school_enrollment TO eduapp_fields_api;
GRANT EXECUTE ON FUNCTION school_enrollment.custom_fields_resource_scope(text, uuid, uuid) TO eduapp_fields_api;

RESET ROLE;

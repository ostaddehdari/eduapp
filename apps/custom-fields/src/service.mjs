import { randomUUID } from 'node:crypto';
import {
  fail, fieldKey, pickObject, readDefinition, revision, typeOfEntity, validateValue,
} from './schema.mjs';

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isUuid = value => typeof value === 'string' && uuidPattern.test(value);
const id = value => isUuid(value) ? value.toLowerCase() : fail();
const definitionColumns = 'id, entity_type, key, label, data_type, constraints_json, required, schema_version, created_at';

function context(identity) {
  if (!isUuid(identity?.actor) || !isUuid(identity.tenantId) || !isUuid(identity.membershipId) ||
    identity.scope !== identity.tenantId) fail('NOT_FOUND');
  return { tenantId: identity.tenantId.toLowerCase(), actor: identity.actor.toLowerCase() };
}

function paging(page) {
  if (!Number.isInteger(page?.limit) || page.limit < 1 || page.limit > 100) fail('INVALID_REQUEST');
  if (page.position != null && !isUuid(page.position)) fail('INVALID_REQUEST');
  return { limit: page.limit, position: page.position?.toLowerCase() ?? null };
}

function definition(row) {
  return {
    id: row.id, entityType: row.entity_type, key: row.key, label: row.label ?? row.key,
    type: row.data_type, constraints: row.constraints_json, required: row.required,
    schemaVersion: row.schema_version, createdAt: row.created_at.toISOString(),
  };
}

function fieldValue(row, scope, definitionRow) {
  return {
    id: row.id, entityType: scope.entityType, entityId: scope.entityId, schoolId: scope.schoolId,
    definitionId: row.definition_id, key: definitionRow.key, schemaVersion: definitionRow.schema_version,
    value: row.value_jsonb, valueVersion: row.value_version, createdAt: row.created_at.toISOString(),
  };
}

function resourceKeys({ entityType, entityId, schoolId }) {
  const type = typeOfEntity(entityType);
  const entity = id(entityId);
  const school = type === 'school' && schoolId === undefined ? entity : id(schoolId);
  if (type === 'school' && school !== entity) fail('NOT_FOUND');
  return { entityType: type, entityId: entity, schoolId: school };
}

async function lock(db, ...parts) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 10405))', [JSON.stringify(parts)]);
}

async function latestDefinition(db, tenantId, entityType, key) {
  const { rows: [version] } = await db.query(`
    SELECT schema_version FROM people_fields.field_definitions
    WHERE tenant_id = $1 AND entity_type = $2 AND key = $3
    ORDER BY schema_version DESC LIMIT 1
  `, [tenantId, entityType, key]);
  return version?.schema_version ?? 0;
}

export function createCustomFields({ transactions, authorize }) {
  if (typeof transactions?.run !== 'function' || typeof authorize !== 'function') {
    throw new TypeError('Custom Fields requires transactions and an owner authorization policy');
  }

  async function approved(identity, target, code = 'NOT_FOUND') {
    if (await authorize({ identity, ...target }) !== true) fail(code);
  }

  function transaction(tenantId, operation) {
    return transactions.run(tenantId, async db => {
      const active = await db.query('SELECT tenancy_organization.custom_fields_tenant_active() AS active');
      if (active.rows[0].active !== true) fail('NOT_FOUND');
      return operation(db);
    });
  }

  async function resource(db, identity, tenantId, scope, operation) {
    const { rows: [target] } = await db.query(
      'SELECT school_enrollment.custom_fields_resource_scope($1, $2, $3) AS org_unit_id',
      [scope.entityType, scope.schoolId, scope.entityId],
    );
    if (!isUuid(target?.org_unit_id)) fail('NOT_FOUND');
    const live = await db.query('SELECT tenancy_organization.custom_fields_tenant_active($1) AS active', [target.org_unit_id]);
    if (live.rows[0].active !== true) fail('NOT_FOUND');
    await approved(identity, {
      tenantId, orgUnitId: target.org_unit_id, action: `fields.${scope.entityType}.${operation}`,
      subjectId: scope.entityId,
    });
  }

  return Object.freeze({
    async listDefinitions({ identity, entityType, key, page }) {
      const { tenantId } = context(identity);
      const type = entityType === undefined ? null : typeOfEntity(entityType);
      const field = key === undefined ? null : fieldKey(key);
      const { limit, position } = paging(page);
      const orgUnitId = identity.orgUnitId == null ? null : id(identity.orgUnitId);
      await approved(identity, { tenantId, orgUnitId, action: 'fields.definition.read' });
      return transaction(tenantId, async db => {
        const { rows } = await db.query(`
          SELECT ${definitionColumns} FROM people_fields.field_definitions
          WHERE tenant_id = $1 AND entity_type IN ('school', 'student') AND data_type IS NOT NULL
            AND ($2::text IS NULL OR entity_type = $2) AND ($3::text IS NULL OR key = $3)
            AND ($4::uuid IS NULL OR id > $4) ORDER BY id LIMIT $5
        `, [tenantId, type, field, position, limit + 1]);
        const data = rows.slice(0, limit).map(definition);
        return { data, nextPosition: rows.length > limit ? data.at(-1).id : null };
      });
    },

    async createDefinition({ identity, body, requestId }) {
      const { tenantId, actor } = context(identity);
      const request = id(requestId);
      const next = readDefinition(body);
      await approved(identity, { tenantId, orgUnitId: null, action: 'fields.definition.write' }, 'FORBIDDEN');
      return transaction(tenantId, async db => {
        await lock(db, 'schema', tenantId, next.entityType, next.key);
        const current = await latestDefinition(db, tenantId, next.entityType, next.key);
        if (current !== next.expectedVersion) fail('CONFLICT');
        const { rows: [created] } = await db.query(`
          INSERT INTO people_fields.field_definitions
            (tenant_id, entity_type, key, label, data_type, constraints_json, required,
             schema_version, sensitivity, created_by, request_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'standard',$9,$10) RETURNING ${definitionColumns}
        `, [tenantId, next.entityType, next.key, next.label, next.type, JSON.stringify(next.constraints),
          next.required, current + 1, actor, request]);
        await db.query('SELECT platform_audit_jobs.append_outbox($1,$2,$3::jsonb)', [
          randomUUID(), 'fields.definition_published.v1',
          JSON.stringify({ definition_id: created.id, schema_version: created.schema_version }),
        ]);
        return definition(created);
      });
    },

    async listValues({ identity, entityType, entityId, schoolId, page }) {
      const { tenantId } = context(identity);
      const scope = resourceKeys({ entityType, entityId, schoolId });
      const { limit, position } = paging(page);
      return transaction(tenantId, async db => {
        await resource(db, identity, tenantId, scope, 'read');
        const values = await db.query(`
          SELECT v.id, v.definition_id, v.value_jsonb, v.value_version, v.created_at, d.key, d.schema_version
          FROM people_fields.field_values v
          JOIN people_fields.field_definitions d ON d.tenant_id = v.tenant_id AND d.id = v.definition_id
          WHERE v.tenant_id = $1 AND v.school_id = $2 AND v.entity_id = $3 AND d.entity_type = $4
            AND ($5::uuid IS NULL OR v.id > $5) ORDER BY v.id LIMIT $6
        `, [tenantId, scope.schoolId, scope.entityId, scope.entityType, position, limit + 1]);
        const data = values.rows.slice(0, limit).map(row => fieldValue(row, scope, row));
        return { data, nextPosition: values.rows.length > limit ? data.at(-1).id : null };
      });
    },

    async createValue({ identity, entityType, entityId, schoolId, body, requestId }) {
      const { tenantId, actor } = context(identity);
      const scope = resourceKeys({ entityType, entityId, schoolId });
      const request = id(requestId);
      pickObject(body, ['definitionId', 'value', 'expectedVersion']);
      const definitionId = id(body.definitionId);
      const expectedVersion = revision(body.expectedVersion);
      if (!Object.hasOwn(body, 'value')) fail();
      return transaction(tenantId, async db => {
        await resource(db, identity, tenantId, scope, 'write');
        const { rows: [schema] } = await db.query(`
          SELECT ${definitionColumns} FROM people_fields.field_definitions
          WHERE tenant_id = $1 AND id = $2 AND entity_type = $3 AND data_type IS NOT NULL
        `, [tenantId, definitionId, scope.entityType]);
        if (!schema) fail('NOT_FOUND');
        await lock(db, 'schema', tenantId, schema.entity_type, schema.key);
        if (schema.schema_version !== await latestDefinition(db, tenantId, schema.entity_type, schema.key)) fail('CONFLICT');
        const value = validateValue(schema.data_type, schema.constraints_json, schema.required, body.value);
        await lock(db, 'value', tenantId, scope.schoolId, scope.entityId, definitionId);
        const { rows: [latest] } = await db.query(`
          SELECT value_version FROM people_fields.field_values
          WHERE tenant_id = $1 AND school_id = $2 AND entity_id = $3 AND definition_id = $4
          ORDER BY value_version DESC LIMIT 1
        `, [tenantId, scope.schoolId, scope.entityId, definitionId]);
        const prior = latest?.value_version ?? 0;
        if (prior !== expectedVersion) fail('CONFLICT');
        const { rows: [saved] } = await db.query(`
          INSERT INTO people_fields.field_values
            (tenant_id, school_id, entity_id, definition_id, value_jsonb, value_version, created_by, request_id)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
          RETURNING id, definition_id, value_jsonb, value_version, created_at
        `, [tenantId, scope.schoolId, scope.entityId, definitionId, JSON.stringify(value), prior + 1, actor, request]);
        return fieldValue(saved, scope, schema);
      });
    },
  });
}

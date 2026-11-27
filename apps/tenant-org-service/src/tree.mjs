import { createHash, randomUUID } from 'node:crypto';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const isUuid = value => typeof value === 'string' && value.length === 36 && uuid.test(value);
const fields = 'id, parent_id, kind, code, COALESCE(name, code) AS name, version';
const roots = new Set(['holding', 'company', 'collection', 'school', 'institute']);
const allowedParents = new Map([
  ['holding', []],
  ['company', ['holding']],
  ['collection', ['holding', 'company', 'collection']],
  ['branch', ['company', 'collection']],
  ['school', ['collection', 'branch']],
  ['institute', ['branch']],
]);

export class OrganizationError extends Error {}

function fail(code) {
  throw new OrganizationError(code);
}

function allowFields(body, names) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).some(name => !names.includes(name))) fail('VALIDATION_FAILED');
}

function idOrNull(id) {
  if (id === null) return null;
  if (!isUuid(id)) fail('VALIDATION_FAILED');
  return id.toLowerCase();
}

function parseCreate(body) {
  allowFields(body, ['parentId', 'kind', 'code', 'name', 'idempotencyKey']);
  const { kind, code, idempotencyKey } = body;
  const name = typeof body.name === 'string' ? body.name.trim().normalize('NFC') : '';
  const parentId = idOrNull(Object.hasOwn(body, 'parentId') ? body.parentId : null);
  if (!allowedParents.has(kind) || typeof code !== 'string' || code.length > 64 || code !== code.trim() ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(code) || [...name].length < 1 || [...name].length > 120 ||
    /[\p{Cc}\p{Cs}]/u.test(name) || typeof idempotencyKey !== 'string' || idempotencyKey !== idempotencyKey.trim() ||
    !/^[A-Za-z0-9._~-]{8,128}$/.test(idempotencyKey)) fail('VALIDATION_FAILED');
  return { parentId, kind, code, name, idempotencyKey };
}

function parseVersion(ifMatch) {
  if (ifMatch === undefined) fail('PRECONDITION_REQUIRED');
  if (typeof ifMatch !== 'string' || ifMatch.at(-1) !== '"' || !/^"[1-9]\d{0,9}"$/.test(ifMatch)) fail('VALIDATION_FAILED');
  const version = Number(ifMatch.slice(1, -1));
  if (version > 2_147_483_647) fail('VALIDATION_FAILED');
  return version;
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

function record(row) {
  return {
    orgUnitId: row.id, parentId: row.parent_id, kind: row.kind, code: row.code, name: row.name, version: row.version,
  };
}

async function verifyTenant(db, tenantId, lock) {
  const result = await db.query(`
    SELECT 1 FROM tenancy_organization.tenants
    WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
    ${lock ? 'FOR SHARE' : ''}
  `, [tenantId]);
  if (result.rowCount !== 1) fail('NOT_FOUND');
}

async function lockTree(db, tenantId) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 10402))', [tenantId]);
}

async function lookupUnit(db, tenantId, orgUnitId) {
  const { rows: [row] } = await db.query(`
    SELECT ${fields} FROM tenancy_organization.org_units WHERE tenant_id = $1 AND id = $2
  `, [tenantId, orgUnitId]);
  return row;
}

async function findParent(db, tenantId, parentId) {
  if (parentId === null) return null;
  const row = await lookupUnit(db, tenantId, parentId);
  if (!row) fail('ORG_PARENT_NOT_FOUND');
  return row;
}

function verifyKind(kind, parent) {
  if (parent ? !allowedParents.get(kind)?.includes(parent.kind) : !roots.has(kind)) fail('VALIDATION_FAILED');
}

async function verifyAncestorChain(db, tenantId, orgUnitId, parentId) {
  if (parentId === null) return;
  const { rows: [chain] } = await db.query(`
    WITH RECURSIVE ancestry(id, parent_id) AS (
      SELECT id, parent_id FROM tenancy_organization.org_units WHERE tenant_id = $1 AND id = $2
      UNION
      SELECT parent.id, parent.parent_id FROM tenancy_organization.org_units AS parent
      JOIN ancestry AS current ON parent.id = current.parent_id
      WHERE parent.tenant_id = $1
    )
    SELECT bool_or(parent_id IS NULL) AS rooted, bool_or(id = $3) AS cycle FROM ancestry
  `, [tenantId, parentId, orgUnitId]);
  if (!chain.rooted || chain.cycle) fail('ORG_CYCLE');
}

async function appendChange(db, item) {
  await db.query('SELECT platform_audit_jobs.append_outbox($1, $2, $3)', [
    randomUUID(), 'tenancy.org_unit_changed.v1',
    JSON.stringify({ org_unit_id: item.orgUnitId, version: item.version }),
  ]);
}

export function createOrganizationTree({ transactions, authorize }) {
  if (typeof transactions?.run !== 'function' || typeof authorize !== 'function') {
    throw new TypeError('Organization tree requires tenant transactions and owner authorization');
  }

  async function authorized(identity, action) {
    const { actor, tenantId, scope, membershipId } = identity ?? {};
    if (!isUuid(actor) || !isUuid(tenantId) || !isUuid(membershipId) || scope !== tenantId) fail('NOT_FOUND');
    if (await authorize({ identity, action, tenantId, orgUnitId: null, targetOrgUnitId: null }) !== true) fail('FORBIDDEN');
    return { actor: actor.toLowerCase(), tenantId: tenantId.toLowerCase() };
  }

  async function change(tenantId, work) {
    try {
      return await transactions.run(tenantId, async db => {
        await verifyTenant(db, tenantId, true);
        await lockTree(db, tenantId);
        return work(db);
      });
    } catch (error) {
      if (error?.code === '23505' && error.constraint === 'org_units_tenant_id_parent_id_code_key') fail('ORG_CODE_CONFLICT');
      throw error;
    }
  }

  return Object.freeze({
    async list({ identity, page }) {
      const { tenantId } = await authorized(identity, 'tenancy.org.read');
      if (!Number.isInteger(page?.limit) || page.limit < 1 || page.limit > 100) fail('INVALID_REQUEST');
      const position = idOrNull(page.position ?? null);
      return transactions.run(tenantId, async db => {
        await verifyTenant(db, tenantId, false);
        const { rows } = await db.query(`
          SELECT ${fields} FROM tenancy_organization.org_units
          WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id > $2)
          ORDER BY id LIMIT $3
        `, [tenantId, position, page.limit + 1]);
        const data = rows.slice(0, page.limit).map(record);
        return { data, nextPosition: rows.length > page.limit ? data.at(-1).orgUnitId : null };
      });
    },

    async create({ identity, body }) {
      const { actor, tenantId } = await authorized(identity, 'tenancy.org.write');
      const { parentId, kind, code, name, idempotencyKey } = parseCreate(body);
      const key = digest(idempotencyKey);
      const fingerprint = digest(JSON.stringify([parentId, kind, code, name]));
      return change(tenantId, async db => {
        const { rows: [previous] } = await db.query(`
          SELECT fingerprint, response FROM tenancy_organization.org_unit_create_requests
          WHERE tenant_id = $1 AND actor_id = $2 AND key_digest = $3
        `, [tenantId, actor, key]);
        if (previous) {
          if (!fingerprint.equals(previous.fingerprint)) fail('IDEMPOTENCY_CONFLICT');
          return previous.response;
        }

        const parent = await findParent(db, tenantId, parentId);
        verifyKind(kind, parent);
        await verifyAncestorChain(db, tenantId, null, parentId);
        const { rows: [created] } = await db.query(`
          INSERT INTO tenancy_organization.org_units (tenant_id, parent_id, kind, code, name)
          VALUES ($1, $2, $3, $4, $5) RETURNING ${fields}
        `, [tenantId, parentId, kind, code, name]);
        const item = record(created);
        await db.query(`
          INSERT INTO tenancy_organization.org_unit_create_requests (tenant_id, actor_id, key_digest, fingerprint, org_unit_id, response)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [tenantId, actor, key, fingerprint, item.orgUnitId, JSON.stringify(item)]);
        await appendChange(db, item);
        return item;
      });
    },

    async move({ identity, orgUnitId, ifMatch, body }) {
      const { tenantId } = await authorized(identity, 'tenancy.org.write');
      if (!isUuid(orgUnitId)) fail('VALIDATION_FAILED');
      const id = orgUnitId.toLowerCase();
      const expectedVersion = parseVersion(ifMatch);
      allowFields(body, ['parentId']);
      const parentId = idOrNull(body.parentId);
      return change(tenantId, async db => {
        const current = await lookupUnit(db, tenantId, id);
        if (!current) fail('NOT_FOUND');
        if (current.version !== expectedVersion) fail('PRECONDITION_FAILED');
        if (parentId === current.parent_id) return record(current);
        if (current.version === 2_147_483_647) fail('CONFLICT');

        const parent = await findParent(db, tenantId, parentId);
        await verifyAncestorChain(db, tenantId, id, parentId);
        verifyKind(current.kind, parent);
        const { rows: [updated] } = await db.query(`
          UPDATE tenancy_organization.org_units SET parent_id = $3, version = version + 1
          WHERE tenant_id = $1 AND id = $2 AND version = $4 RETURNING ${fields}
        `, [tenantId, id, parentId, expectedVersion]);
        if (!updated) fail('PRECONDITION_FAILED');
        const item = record(updated);
        await appendChange(db, item);
        return item;
      });
    },
  });
}

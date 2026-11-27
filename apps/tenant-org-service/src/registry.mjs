import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXPECTED_VERSION_LIMIT = 2_147_483_647;
const DAY_MS = 86_400_000;
const budget = { max: 30, windowSeconds: 60 };

const tenantView = `
  SELECT t.id, t.slug, t.display_name, t.status, t.owner_identity_id, t.owner_membership_id,
         t.trial_ends_at, t.version, t.created_at, t.updated_at, le.name AS legal_name,
         le.country_code, le.registration_number
  FROM tenancy_organization.tenants AS t
  JOIN tenancy_organization.legal_entities AS le ON le.tenant_id = t.id
  WHERE t.id = $1 AND t.deleted_at IS NULL AND t.owner_membership_id IS NOT NULL
`;

export class TenantRegistryError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) {
  throw new TenantRegistryError(code);
}

function isUuid(value) {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}

function strictObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) fail('VALIDATION_FAILED');
}

function requiredText(value, limit) {
  if (typeof value !== 'string') fail('VALIDATION_FAILED');
  const trimmed = value.trim();
  if (!trimmed || [...trimmed].length > limit || /[\u0000-\u001f\u007f]/u.test(trimmed)) fail('VALIDATION_FAILED');
  return trimmed;
}

function normalizeCreation(body) {
  strictObject(body, ['slug', 'displayName', 'ownerIdentityId', 'legalEntity', 'trialDays']);
  strictObject(body.legalEntity, ['name', 'countryCode', 'registrationNumber']);
  const { slug, ownerIdentityId } = body;
  const { countryCode } = body.legalEntity;
  const trialDays = body.trialDays === undefined ? null : body.trialDays;
  if (typeof slug !== 'string' || slug !== slug.trim() || !SLUG.test(slug) || !isUuid(ownerIdentityId) ||
      typeof countryCode !== 'string' || countryCode.length !== 2 || !/^[A-Z]{2}$/.test(countryCode) ||
      (body.trialDays !== undefined && (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 30))) {
    fail('VALIDATION_FAILED');
  }
  return {
    slug, displayName: requiredText(body.displayName, 160), ownerIdentityId,
    legalEntity: {
      name: requiredText(body.legalEntity.name, 160), countryCode,
      registrationNumber: requiredText(body.legalEntity.registrationNumber, 64),
    },
    trialDays,
  };
}

const digest = (text) => createHash('sha256').update(text).digest('hex');

function commandKey(identity, value, idempotency) {
  const context = idempotency?.namespace;
  const fingerprint = idempotency?.fingerprint;
  if (!Array.isArray(context) || context.length !== 4 || context[0] !== identity.scope ||
      context[1] !== identity.actor || context[2] !== 'createTenant' || typeof context[3] !== 'string' ||
      !/^[\x21-\x2b\x2d-\x7e]{8,128}$/.test(context[3]) ||
      typeof fingerprint !== 'string' || !SHA256.test(fingerprint)) fail('VALIDATION_FAILED');
  const identifier = digest(JSON.stringify(['eduapp.registry.create.v1', ...context]));
  const tenantId = `${identifier.slice(0, 8)}-${identifier.slice(8, 12)}-8${identifier.slice(13, 16)}-8${identifier.slice(17, 20)}-${identifier.slice(20, 32)}`;
  return { tenantId, fingerprint: digest(JSON.stringify([value, fingerprint])) };
}

function assertAuthenticated(identity) {
  if (!isUuid(identity?.actor) || typeof identity.scope !== 'string' || identity.scope.length > 80 ||
    !identity.scope) fail('AUTHENTICATION_REQUIRED');
}

function selectedTenant(identity) {
  assertAuthenticated(identity);
  return isUuid(identity.tenantId) && isUuid(identity.membershipId) && identity.scope === identity.tenantId
    ? identity.tenantId
    : null;
}

function authorizedSource(proof) {
  if (proof?.kind === 'platform_admin') return { kind: 'platform_admin', paymentDigest: null };
  if (proof?.kind === 'verified_payment' && typeof proof.reference === 'string' &&
    proof.reference.length > 0 && proof.reference.length <= 256) {
    return { kind: 'verified_payment', paymentDigest: digest(proof.reference) };
  }
  fail('FORBIDDEN');
}

function tenantProjection(row) {
  return {
    id: row.id, slug: row.slug, displayName: row.display_name, status: row.status,
    ownerIdentityId: row.owner_identity_id, ownerMembershipId: row.owner_membership_id,
    legalEntity: { name: row.legal_name, countryCode: row.country_code, registrationNumber: row.registration_number },
    trialEndsAt: row.trial_ends_at?.toISOString() ?? null, version: row.version,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

async function readTenant(db, tenantId, status) {
  const { rows: [tenant] } = await db.query(
    tenantView + (status === 'active' ? " AND t.status = 'active'" : ''), [tenantId],
  );
  return tenant ? tenantProjection(tenant) : null;
}

async function appendAudit(db, { tenantId, actorId, requestId, action, instant }) {
  await db.query(`
    INSERT INTO tenancy_organization.registry_audit_facts
      (tenant_id, actor_id, request_id, action, occurred_at) VALUES ($1,$2,$3,$4,$5)
  `, [tenantId, actorId, requestId, action, instant]);
}

export function createTenantRegistry({ transactions, authorizeProvisioning, authorizeTenant, authorizeStatusChange, now = Date.now }) {
  if (typeof transactions?.run !== 'function' || typeof authorizeProvisioning !== 'function' ||
      typeof authorizeTenant !== 'function' || typeof authorizeStatusChange !== 'function') {
    throw new TypeError('Tenant Registry requires an owner transaction and authorization callbacks');
  }

  return Object.freeze({
    async create({ identity, body, requestId, idempotency }) {
      assertAuthenticated(identity);
      if (!isUuid(requestId)) fail('VALIDATION_FAILED');
      const value = normalizeCreation(body);
      const command = commandKey(identity, value, idempotency);
      const source = authorizedSource(await authorizeProvisioning({ identity, requestId, body: value }));
      const { tenantId, fingerprint } = command;
      try {
        return await transactions.run(tenantId, async (db) => {
          const reserved = await db.query(`
            INSERT INTO tenancy_organization.registry_create_commands
              (tenant_id, actor_id, fingerprint, proof_kind, payment_reference_digest) VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT (tenant_id) DO NOTHING
          `, [tenantId, identity.actor, fingerprint, source.kind, source.paymentDigest]);
          if (reserved.rowCount === 0) {
            const { rows: [existing] } = await db.query(`
              SELECT actor_id, fingerprint, proof_kind, payment_reference_digest, result
              FROM tenancy_organization.registry_create_commands WHERE tenant_id = $1
            `, [tenantId]);
            if (!existing || existing.actor_id !== identity.actor || existing.fingerprint !== fingerprint ||
                existing.proof_kind !== source.kind || existing.payment_reference_digest !== source.paymentDigest) {
              fail('IDEMPOTENCY_CONFLICT');
            }
            if (!existing.result) fail('IDEMPOTENCY_IN_PROGRESS');
            return existing.result;
          }
          const instant = new Date(now());
          const trialEnds = value.trialDays === null ? null : new Date(instant.getTime() + value.trialDays * DAY_MS);
          await db.query(`
            INSERT INTO tenancy_organization.tenants
              (id, slug, display_name, owner_identity_id, status, trial_ends_at, created_at, updated_at)
            VALUES ($1,$2,$3,$4,'active',$5,$6,$6)
          `, [tenantId, value.slug, value.displayName, value.ownerIdentityId, trialEnds, instant]);
          const legal = value.legalEntity;
          await db.query(`
            INSERT INTO tenancy_organization.legal_entities (tenant_id, name, country_code, registration_number)
            VALUES ($1,$2,$3,$4)
          `, [tenantId, legal.name, legal.countryCode, legal.registrationNumber]);
          const { rows: [owner] } = await db.query(
            'SELECT identity_access.bootstrap_registry_owner($1) AS membership_id', [value.ownerIdentityId],
          );
          await db.query('UPDATE tenancy_organization.tenants SET owner_membership_id = $2 WHERE id = $1',
            [tenantId, owner.membership_id]);
          await appendAudit(db, { tenantId, actorId: identity.actor, requestId, action: 'tenant_created', instant });
          await db.query('SELECT platform_audit_jobs.append_registry_created()');
          const result = await readTenant(db, tenantId);
          await db.query('UPDATE tenancy_organization.registry_create_commands SET result = $2::jsonb WHERE tenant_id = $1',
            [tenantId, JSON.stringify(result)]);
          return result;
        });
      } catch (error) {
        if (error.code === '23505') fail('CONFLICT');
        if (error.code === 'P0002') fail('VALIDATION_FAILED');
        throw error;
      }
    },

    async get({ identity, tenantId, requestId }) {
      if (!isUuid(tenantId)) fail('VALIDATION_FAILED');
      if (selectedTenant(identity) !== tenantId || await authorizeTenant({ identity, tenantId, requestId }) !== true) {
        fail('NOT_FOUND');
      }
      const tenant = await transactions.run(tenantId, (db) => readTenant(db, tenantId, 'active'));
      if (!tenant) fail('NOT_FOUND');
      return tenant;
    },

    async list({ identity, requestId, page }) {
      const tenantId = selectedTenant(identity);
      if (!tenantId || page.position !== null || await authorizeTenant({ identity, tenantId, requestId }) !== true) {
        return { data: [], nextPosition: null };
      }
      const tenant = await transactions.run(tenantId, (db) => readTenant(db, tenantId, 'active'));
      return { data: tenant ? [tenant] : [], nextPosition: null };
    },

    async setStatus({ identity, tenantId, body, requestId }) {
      assertAuthenticated(identity);
      strictObject(body, ['status', 'expectedVersion']);
      const { status, expectedVersion } = body;
      if (!isUuid(tenantId) || !isUuid(requestId) || !['active', 'suspended'].includes(status) ||
        !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || expectedVersion > EXPECTED_VERSION_LIMIT) {
        fail('VALIDATION_FAILED');
      }
      if (await authorizeStatusChange({ identity, tenantId, status, requestId }) !== true) fail('FORBIDDEN');
      return transactions.run(tenantId, async (db) => {
        const { rows: [current] } = await db.query(`
          SELECT version, status FROM tenancy_organization.tenants
          WHERE id = $1 AND deleted_at IS NULL AND owner_membership_id IS NOT NULL FOR UPDATE
        `, [tenantId]);
        if (!current) fail('NOT_FOUND');
        if (current.version !== expectedVersion) fail('PRECONDITION_FAILED');
        if (current.status !== status) {
          const instant = new Date(now());
          await db.query(`
            UPDATE tenancy_organization.tenants SET status = $2, version = version + 1, updated_at = $3
            WHERE id = $1
          `, [tenantId, status, instant]);
          await appendAudit(db, { tenantId, actorId: identity.actor, requestId, instant,
            action: status === 'suspended' ? 'tenant_suspended' : 'tenant_reactivated' });
        }
        return readTenant(db, tenantId);
      });
    },

    async isActive(tenantId) {
      if (!isUuid(tenantId)) return false;
      return transactions.run(tenantId, async (db) => {
        const active = await db.query(`
          SELECT 1 FROM tenancy_organization.tenants WHERE id = $1 AND status = 'active' AND deleted_at IS NULL
        `, [tenantId]);
        return active.rowCount === 1;
      });
    },
  });
}

export function createTenantRegistryRoutes({ registry, GatewayError }) {
  const wrap = (action) => async (input) => {
    try {
      return await action(input);
    } catch (error) {
      if (error instanceof TenantRegistryError) throw new GatewayError(error.code);
      throw error;
    }
  };
  const item = (data, status = 200) => ({ status, data, etag: `"${data.version}"` });
  const authorize = ({ identity }) => isUuid(identity?.actor);
  return [
    {
      id: 'createTenant', budget, authorize,
      executeIdempotent: (context, execute) => execute(context),
      handle: wrap(async (input) => item(await registry.create(input), 201)),
    },
    {
      id: 'listTenants', budget, authorize, handle: wrap((input) => registry.list(input)),
    },
    {
      id: 'getTenant', budget, authorize,
      handle: wrap(async ({ params, ...input }) => item(await registry.get({ ...input, tenantId: params.tenantId }))),
    },
    {
      id: 'updateTenantStatus', budget, authorize,
      handle: wrap(async ({ params, ...input }) => item(await registry.setStatus({ ...input, tenantId: params.tenantId }))),
    },
  ];
}

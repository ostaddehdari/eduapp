import { createHash, randomUUID } from 'node:crypto';
import { OrganizationError } from './tree.mjs';

const steps = ['organization', 'school', 'invitation', 'site', 'completed'];
const kinds = new Set(['holding', 'company', 'collection', 'school', 'institute']);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const isUuid = value => typeof value === 'string' && value.length === 36 && uuid.test(value);

export class OnboardingError extends Error {}
const fail = code => { throw new OnboardingError(code); };

function validateFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !fields.includes(key))) fail('VALIDATION_FAILED');
}

function name(value) {
  const normalized = typeof value === 'string' ? value.trim().normalize('NFC') : '';
  if (!normalized || [...normalized].length > 120 || /[\p{Cc}\p{Cs}]/u.test(normalized)) fail('VALIDATION_FAILED');
  return normalized;
}

function code(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) fail('VALIDATION_FAILED');
  return value;
}

function normalize(step, input) {
  switch (step) {
    case 'organization':
      validateFields(input, ['kind', 'name', 'code']);
      if (!kinds.has(input.kind)) fail('VALIDATION_FAILED');
      return { kind: input.kind, name: name(input.name), code: code(input.code) };
    case 'school': {
      validateFields(input, ['layout', 'name', 'code', 'branchName', 'branchCode']);
      const common = { layout: input.layout, name: name(input.name), code: code(input.code) };
      if (input.layout === 'branch') return { ...common, branchName: name(input.branchName), branchCode: code(input.branchCode) };
      if (input.layout !== 'standalone' || input.branchName !== undefined || input.branchCode !== undefined) fail('VALIDATION_FAILED');
      return common;
    }
    case 'invitation':
      validateFields(input, ['identityId']);
      if (!isUuid(input.identityId)) fail('VALIDATION_FAILED');
      return { identityId: input.identityId };
    case 'site':
      validateFields(input, ['name', 'slug']);
      return { name: name(input.name), slug: code(input.slug) };
    default:
      fail('VALIDATION_FAILED');
  }
}

function key(...parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function stableId(...parts) {
  const hex = key(...parts);
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-8' + hex.slice(13, 16) + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

function snapshot(row) {
  const { version = 0, draft = {} } = row ?? {};
  return { version, step: steps[version], draft };
}

export function createOnboarding({
  transactions, schoolTransactions, sitesTransactions, tree, authorize, inviteManager,
}) {
  if (typeof schoolTransactions?.run !== 'function' || typeof sitesTransactions?.run !== 'function' ||
    typeof inviteManager !== 'function') throw new TypeError('Onboarding requires School, Sites and invitation owners');

  async function authorizeOwner(identity) {
    const { actor, tenantId, membershipId, scope } = identity ?? {};
    if (!isUuid(actor) || !isUuid(tenantId) || !isUuid(membershipId) || scope !== tenantId) fail('NOT_FOUND');
    if (await authorize({ identity, tenantId, action: 'tenancy.org.write' }) !== true) fail('FORBIDDEN');
    return tenantId;
  }

  async function readActive(db, tenantId) {
    const { rowCount } = await db.query(
      "SELECT 1 FROM tenancy_organization.tenants WHERE id = $1 AND status = 'active' AND deleted_at IS NULL", [tenantId],
    );
    if (rowCount !== 1) fail('NOT_FOUND');
  }

  async function createUnit(identity, requestId, step, body) {
    const idempotencyKey = key('onboarding', identity.tenantId, step, body);
    try {
      return await tree.create({ identity, requestId, body: { ...body, idempotencyKey } });
    } catch (error) {
      if (error instanceof OrganizationError) fail(error.message);
      throw error;
    }
  }

  async function createSchool(tenantId, orgUnitId) {
    return schoolTransactions.run(tenantId, async db => {
      await db.query(`
        INSERT INTO school_enrollment.schools (tenant_id, org_unit_id) VALUES ($1, $2)
        ON CONFLICT (tenant_id, org_unit_id) DO NOTHING
      `, [tenantId, orgUnitId]);
      return (await db.query('SELECT id FROM school_enrollment.schools WHERE tenant_id = $1 AND org_unit_id = $2',
        [tenantId, orgUnitId])).rows[0].id;
    });
  }

  async function createSite(tenantId, orgUnitId, input) {
    const siteId = stableId('onboarding-site', tenantId, orgUnitId, input);
    return sitesTransactions.run(tenantId, async db => {
      try {
        await db.query(`
          INSERT INTO sites_content.sites (tenant_id, id, org_unit_id, draft_name, draft_slug)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, id) DO NOTHING
        `, [tenantId, siteId, orgUnitId, input.name, input.slug]);
      } catch (error) {
        if (error.code === '23505') fail('CONFLICT');
        throw error;
      }
      return { ...input, siteId, status: 'draft' };
    });
  }

  async function execute(identity, tenantId, step, draft, input, requestId) {
    switch (step) {
      case 'organization': {
        const org = await createUnit(identity, requestId, step, { ...input, parentId: null });
        return { ...input, orgUnitId: org.orgUnitId };
      }
      case 'school': {
        let parentId = null;
        if (input.layout === 'branch') {
          if (!['company', 'collection'].includes(draft.organization.kind)) fail('VALIDATION_FAILED');
          const branch = await createUnit(identity, requestId, 'branch', {
            kind: 'branch', name: input.branchName, code: input.branchCode, parentId: draft.organization.orgUnitId,
          });
          parentId = branch.orgUnitId;
        }
        const org = await createUnit(identity, requestId, 'school', {
          kind: 'school', name: input.name, code: input.code, parentId,
        });
        const schoolId = await createSchool(tenantId, org.orgUnitId);
        return { ...input, orgUnitId: org.orgUnitId, schoolId };
      }
      case 'invitation': {
        const result = await inviteManager({
          identity, requestId, body: { ...input, orgUnitId: draft.school.orgUnitId },
          commandId: stableId('onboarding-invite', tenantId, draft.school.orgUnitId, input),
        });
        return { ...input, invitationId: result.invitationId, status: result.status };
      }
      case 'site':
        if (!await tree.verifyOrgUnit({ tenantId, orgUnitId: draft.school.orgUnitId })) fail('NOT_FOUND');
        return createSite(tenantId, draft.school.orgUnitId, input);
      default:
        fail('VALIDATION_FAILED');
    }
  }

  return Object.freeze({
    async read({ identity }) {
      const tenantId = await authorizeOwner(identity);
      return transactions.run(tenantId, async db => {
        await readActive(db, tenantId);
        const { rows: [row] } = await db.query(
          'SELECT version, draft FROM tenancy_organization.onboarding_progress WHERE tenant_id = $1', [tenantId],
        );
        return snapshot(row);
      });
    },

    async advance({ identity, body, requestId }) {
      const tenantId = await authorizeOwner(identity);
      validateFields(body, ['expectedVersion', 'step', 'input']);
      const { expectedVersion, step } = body;
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0 || expectedVersion > 3 ||
        steps[expectedVersion] !== step || !isUuid(requestId)) fail('VALIDATION_FAILED');
      const input = normalize(step, body.input);
      const claimId = randomUUID();
      const fingerprint = key(step, input);
      const draft = await transactions.run(tenantId, async db => {
        await readActive(db, tenantId);
        await db.query('INSERT INTO tenancy_organization.onboarding_progress (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [tenantId]);
        const { rows: [row] } = await db.query(`
          UPDATE tenancy_organization.onboarding_progress
          SET claim_id = $3, claimed_until = now() + interval '2 minutes', claim_fingerprint = $4
          WHERE tenant_id = $1 AND version = $2 AND (claimed_until IS NULL OR claimed_until <= now())
            AND (claim_fingerprint IS NULL OR claim_fingerprint = $4)
          RETURNING draft
        `, [tenantId, expectedVersion, claimId, fingerprint]);
        if (!row) {
          const { rows: [current] } = await db.query(
            'SELECT version, claim_fingerprint FROM tenancy_organization.onboarding_progress WHERE tenant_id = $1', [tenantId],
          );
          if (current.version !== expectedVersion) fail('PRECONDITION_FAILED');
          if (current.claim_fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT');
          fail('IDEMPOTENCY_IN_PROGRESS');
        }
        return row.draft;
      });

      try {
        const result = await execute(identity, tenantId, step, draft, input, requestId);
        return await transactions.run(tenantId, async db => {
          await readActive(db, tenantId);
          const { rows: [row] } = await db.query(`
            UPDATE tenancy_organization.onboarding_progress
            SET version = version + 1, draft = $4, claim_id = NULL, claimed_until = NULL, claim_fingerprint = NULL
            WHERE tenant_id = $1 AND version = $2 AND claim_id = $3 RETURNING version, draft
          `, [tenantId, expectedVersion, claimId, JSON.stringify({ ...draft, [step]: result })]);
          if (!row) fail('PRECONDITION_FAILED');
          return snapshot(row);
        });
      } catch (error) {
        await transactions.run(tenantId, db => db.query(`
          UPDATE tenancy_organization.onboarding_progress
          SET claim_id = NULL, claimed_until = NULL, claim_fingerprint = NULL
          WHERE tenant_id = $1 AND claim_id = $2
        `, [tenantId, claimId]));
        throw error;
      }
    },
  });
}

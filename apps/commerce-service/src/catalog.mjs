import { createTenantTransactions } from '../../../packages/data/src/tenant-transactions.mjs';

export class CatalogError extends Error {}
const fail = code => { throw new CatalogError(code); };
const key = value => typeof value === 'string' && /^[a-z][a-z0-9_]{1,47}$/.test(value);
const couponKey = value => typeof value === 'string' && /^[A-Z0-9_-]{4,32}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function validateOffer(body) {
  if (!object(body) || Object.keys(body).some(k => ![
    'code', 'expectedVersion', 'priceMinor', 'currency', 'modules', 'quotas', 'trialDays', 'termDays',
  ].includes(k)) || !key(body.code) || !integer(body.expectedVersion, 0, 1_000_000) ||
    !integer(body.priceMinor, 0, 1_000_000_000_000) || body.currency !== 'IRR' ||
    !integer(body.trialDays, 0, 90) || !integer(body.termDays, 1, 366) ||
    !Array.isArray(body.modules) || body.modules.length > 64 ||
    !body.modules.every(key) || new Set(body.modules).size !== body.modules.length ||
    !object(body.quotas) || Object.keys(body.quotas).length > 64 ||
    !Object.entries(body.quotas).every(([k, v]) => key(k) && integer(v, 0, 1_000_000_000))) {
    fail('VALIDATION_FAILED');
  }
}

function view(row) {
  return {
    id: row.id, planId: row.plan_id, code: row.code, version: row.version,
    priceMinor: String(row.price_minor), currency: row.currency, modules: row.modules,
    quotas: row.quotas, trialDays: row.trial_days, termDays: row.term_days,
    effectiveAt: row.effective_at.toISOString(),
  };
}

export function createPlanCatalog({ pool, authorizePublish, authorizeQuote = async () => false, now = () => new Date() }) {
  if (typeof pool?.connect !== 'function' || typeof pool?.query !== 'function' ||
    typeof authorizePublish !== 'function' || typeof authorizeQuote !== 'function') {
    throw new TypeError('Billing owner and independent authorization policies required');
  }
  const transactions = createTenantTransactions(pool);

  async function publish(identity, body) {
    validateOffer(body);
    if (await authorizePublish({ identity, action: 'billing.plan.publish' }) !== true) fail('FORBIDDEN');
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 10501))', [body.code]);
      await db.query(`INSERT INTO commercial_billing.plans(code,status) VALUES($1,'published') ON CONFLICT(code) DO NOTHING`,
        [body.code]);
      const { rows: [plan] } = await db.query(
        'SELECT id,status FROM commercial_billing.plans WHERE code = $1', [body.code]);
      if (plan.status !== 'published') fail('CONFLICT');
      const { rows: [prior] } = await db.query(
        'SELECT version FROM commercial_billing.plan_versions WHERE plan_id = $1 AND version IS NOT NULL ORDER BY version DESC LIMIT 1',
        [plan.id]);
      if ((prior?.version ?? 0) !== body.expectedVersion) fail('CONFLICT');
      const { rows: [row] } = await db.query(`
        INSERT INTO commercial_billing.plan_versions
          (plan_id,version,price_minor,currency,effective_at,modules,quotas,trial_days,term_days)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)
        RETURNING id,plan_id,version,price_minor,currency,effective_at,modules,quotas,trial_days,term_days
      `, [plan.id, body.expectedVersion + 1, body.priceMinor, body.currency, now(),
        JSON.stringify(body.modules), JSON.stringify(body.quotas), body.trialDays, body.termDays]);
      const commit = await db.query('COMMIT');
      if (commit.command !== 'COMMIT') throw new Error('Catalog commit failed');
      return view({ ...row, code: body.code });
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  async function publishDiscount(identity, { code, planId, percentage, validFrom, validTo }) {
    if (!couponKey(code) || !uuid(planId) || !integer(percentage, 1, 100) ||
      !Number.isFinite(Date.parse(validFrom)) || !Number.isFinite(Date.parse(validTo)) ||
      Date.parse(validFrom) >= Date.parse(validTo)) fail('VALIDATION_FAILED');
    if (await authorizePublish({ identity, action: 'billing.discount.publish' }) !== true) fail('FORBIDDEN');
    const { rows: [row] } = await pool.query(`
      INSERT INTO commercial_billing.discount_codes(code,plan_id,percentage,valid_from,valid_to)
      VALUES ($1,$2,$3,$4,$5) RETURNING code,percentage
    `, [code, planId, percentage, validFrom, validTo]);
    return row;
  }

  async function list({ page }) {
    if (!integer(page?.limit, 1, 100) || (page.position != null && !uuid(page.position))) fail('INVALID_REQUEST');
    const { rows } = await pool.query(`
      SELECT v.id,v.plan_id,p.code,v.version,v.price_minor,v.currency,v.modules,v.quotas,
        v.trial_days,v.term_days,v.effective_at
      FROM commercial_billing.plan_versions v JOIN commercial_billing.plans p ON p.id = v.plan_id
      WHERE p.status = 'published' AND v.version IS NOT NULL AND v.effective_at <= $1
        AND ($2::uuid IS NULL OR v.id > $2)
      ORDER BY v.id LIMIT $3
    `, [now(), page.position ?? null, page.limit + 1]);
    const data = rows.slice(0, page.limit).map(view);
    return { data, nextPosition: rows.length > page.limit ? data.at(-1).id : null };
  }

  async function quote({ identity, planVersionId, discountCode }) {
    if (!uuid(identity?.tenantId) || identity.scope !== identity.tenantId || !uuid(planVersionId) ||
      (discountCode !== undefined && !couponKey(discountCode))) fail('INVALID_REQUEST');
    if (await authorizeQuote({ identity, action: 'billing.quote.read' }) !== true) fail('FORBIDDEN');
    return transactions.run(identity.tenantId, async db => {
      const { rows: [row] } = await db.query(`
        SELECT v.id,v.plan_id,p.code,v.version,v.price_minor,v.currency,v.modules,v.quotas,
          v.trial_days,v.term_days,v.effective_at
        FROM commercial_billing.plan_versions v JOIN commercial_billing.plans p ON p.id = v.plan_id
        WHERE v.id = $1 AND p.status = 'published' AND v.version IS NOT NULL AND v.effective_at <= $2
      `, [planVersionId, now()]);
      if (!row) fail('NOT_FOUND');
      const { rows: [prior] } = await db.query(
        'SELECT count(*)::integer AS used FROM commercial_billing.subscriptions WHERE tenant_id = $1',
        [identity.tenantId]);
      let percentage = 0;
      if (discountCode) {
        const { rows: [discount] } = await db.query(`
          SELECT percentage FROM commercial_billing.discount_codes
          WHERE code = $1 AND plan_id = $2 AND valid_from <= $3 AND valid_to > $3
        `, [discountCode, row.plan_id, now()]);
        if (!discount) fail('VALIDATION_FAILED');
        percentage = discount.percentage;
      }
      const price = BigInt(row.price_minor);
      const payable = price - price * BigInt(percentage) / 100n;
      return {
        plan: view(row), discountPercent: percentage, payableMinor: String(payable),
        trialDays: prior.used === 0 ? row.trial_days : 0,
        termDays: row.term_days, renewal: prior.used > 0,
        // A quote never grants entitlement or mutates an existing subscription.
        requiresVerifiedPayment: payable > 0n,
      };
    });
  }

  return Object.freeze({ publish, publishDiscount, list, quote });
}

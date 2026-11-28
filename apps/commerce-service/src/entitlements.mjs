import { createTenantTransactions } from '../../../packages/data/src/tenant-transactions.mjs';

export class EntitlementError extends Error {}
const fail = code => { throw new EntitlementError(code); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const featureName = value => typeof value === 'string' && /^[a-z][a-z0-9_]{1,47}$/.test(value);

export function createEntitlementService({ pool, authorizePermission, now = () => new Date() }) {
  if (typeof pool?.connect !== 'function' || typeof authorizePermission !== 'function') {
    throw new TypeError('A billing pool and independent permission policy are required');
  }
  const transactions = createTenantTransactions(pool);

  async function available(db, tenantId, feature, instant, period) {
    const { rows: [row] } = await db.query(`
      SELECT e.limit_value, COALESCE(u.used, 0) AS used
      FROM commercial_billing.entitlements e
      JOIN commercial_billing.subscriptions s
        ON s.tenant_id = e.tenant_id AND s.id = e.source_subscription_id
      JOIN commercial_billing.feature_flags f ON f.feature = e.feature AND f.enabled
      LEFT JOIN commercial_billing.usage_counters u
        ON u.tenant_id = e.tenant_id AND u.feature = e.feature AND u.period = $3
      WHERE e.tenant_id = $1 AND e.feature = $2 AND s.status = 'active'
        AND e.valid_from <= $4 AND (e.valid_to IS NULL OR e.valid_to > $4)
      ORDER BY e.valid_from DESC, e.id DESC LIMIT 1
    `, [tenantId, feature, period, instant]);
    return row ? { limit: row.limit_value === null ? null : BigInt(row.limit_value), used: BigInt(row.used) } : null;
  }

  function validateTenant(tenantId, feature) {
    if (!uuid(tenantId) || !featureName(feature)) fail('INVALID_REQUEST');
  }

  // Pass this function to AccessService.hasEntitlement; permission remains a separate decision.
  async function hasEntitlement({ tenantId, feature }) {
    validateTenant(tenantId, feature);
    const instant = now();
    const period = instant.toISOString().slice(0, 7);
    return transactions.run(tenantId, async db => {
      const grant = await available(db, tenantId, feature, instant, period);
      return grant !== null && (grant.limit === null || grant.used < grant.limit);
    });
  }

  async function check({ identity, feature, action }) {
    validateTenant(identity?.tenantId, feature);
    if (identity.scope !== identity.tenantId ||
      await authorizePermission({ identity, action, feature }) !== true) return false;
    return hasEntitlement({ tenantId: identity.tenantId, feature });
  }

  async function reserve({ identity, feature, action, requestKey, amount = 1 }) {
    validateTenant(identity?.tenantId, feature);
    if (!uuid(requestKey) || !Number.isSafeInteger(amount) || amount < 1 || amount > 1_000_000) {
      fail('INVALID_REQUEST');
    }
    if (identity.scope !== identity.tenantId ||
      await authorizePermission({ identity, action, feature }) !== true) fail('FORBIDDEN');
    const instant = now();
    const period = instant.toISOString().slice(0, 7);
    return transactions.run(identity.tenantId, async db => {
      // One lock covers retries and quota changes for the tenant and feature.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 10502))',
        [identity.tenantId + ':' + feature]);
      const { rows: [previous] } = await db.query(`
        SELECT feature,period,amount,used_after FROM commercial_billing.usage_requests
        WHERE tenant_id = $1 AND request_key = $2
      `, [identity.tenantId, requestKey]);
      if (previous) {
        if (previous.feature !== feature || previous.period !== period || BigInt(previous.amount) !== BigInt(amount)) {
          fail('CONFLICT');
        }
        return { used: String(previous.used_after), replayed: true };
      }
      const grant = await available(db, identity.tenantId, feature, instant, period);
      if (!grant || (grant.limit !== null && grant.used + BigInt(amount) > grant.limit)) fail('FORBIDDEN');
      const { rows: [counter] } = await db.query(`
        INSERT INTO commercial_billing.usage_counters(tenant_id,feature,period,used)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (tenant_id,feature,period) DO UPDATE SET used = commercial_billing.usage_counters.used + EXCLUDED.used
        RETURNING used
      `, [identity.tenantId, feature, period, amount]);
      await db.query(`
        INSERT INTO commercial_billing.usage_requests(tenant_id,request_key,feature,period,amount,used_after)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [identity.tenantId, requestKey, feature, period, amount, counter.used]);
      return { used: String(counter.used), replayed: false };
    });
  }

  return Object.freeze({ hasEntitlement, check, reserve });
}

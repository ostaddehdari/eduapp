import { createHash } from 'node:crypto';
import { createTenantTransactions } from '../../../packages/data/src/tenant-transactions.mjs';

export class CheckoutError extends Error {}
const fail = code => { throw new CheckoutError(code); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const moduleName = value => typeof value === 'string' && /^[a-z][a-z0-9_]{1,47}$/.test(value);
const validIdentity = identity => uuid(identity?.tenantId) && identity.scope === identity.tenantId;
const payload = row => ({
  id: row.id, invoiceId: row.invoice_id, subscriptionId: row.subscription_id,
  planVersionId: row.plan_version_id, modules: row.modules, seats: row.seats,
  amountMinor: String(row.amount_minor), currency: row.currency, status: row.status,
});

export function createCheckout({ pool, authorizeOrder, authorizeLifecycle, now = () => new Date() }) {
  if (typeof pool?.connect !== 'function' || typeof authorizeOrder !== 'function' ||
    typeof authorizeLifecycle !== 'function') throw new TypeError('Billing policies are required');
  const transactions = createTenantTransactions(pool);

  async function order({ identity, planVersionId, modules, seats, requestKey }) {
    if (!validIdentity(identity) || !uuid(planVersionId) || !uuid(requestKey) ||
      !Array.isArray(modules) || modules.length > 64 || !modules.every(moduleName) ||
      new Set(modules).size !== modules.length || !Number.isSafeInteger(seats) || seats < 1 || seats > 1_000_000) {
      fail('INVALID_REQUEST');
    }
    if (await authorizeOrder({ identity, action: 'billing.checkout.create' }) !== true) fail('FORBIDDEN');
    const selected = [...modules].sort();
    const hash = createHash('sha256').update(JSON.stringify([planVersionId, selected, seats])).digest('hex');
    return transactions.run(identity.tenantId, async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 10504))',
        [identity.tenantId + ':' + requestKey]);
      const { rows: [prior] } = await db.query(
        'SELECT * FROM commercial_billing.checkout_orders WHERE tenant_id = $1 AND request_key = $2',
        [identity.tenantId, requestKey]);
      if (prior) {
        if (prior.request_hash !== hash) fail('CONFLICT');
        return { ...payload(prior), replayed: true };
      }
      const { rows: [plan] } = await db.query(`
        SELECT v.id, v.price_minor, v.currency, v.modules, v.quotas FROM commercial_billing.plan_versions v
        JOIN commercial_billing.plans p ON p.id = v.plan_id
        WHERE v.id = $1 AND v.version IS NOT NULL AND v.effective_at <= $2 AND p.status = 'published'
      `, [planVersionId, now()]);
      if (!plan) fail('NOT_FOUND');
      if (plan.currency !== 'IRR' || !selected.every(item => plan.modules.includes(item)) ||
        !Number.isSafeInteger(plan.quotas.seats) || seats > plan.quotas.seats) fail('VALIDATION_FAILED');
      // Catalog price is for the full plan. No unapproved per-module or per-seat price is invented.
      const { rows: [subscription] } = await db.query(`
        INSERT INTO commercial_billing.subscriptions(tenant_id,plan_version_id,status)
        VALUES ($1,$2,'pending_payment') RETURNING id
      `, [identity.tenantId, planVersionId]);
      const { rows: [invoice] } = await db.query(`
        INSERT INTO commercial_billing.invoices(tenant_id,subscription_id,amount_minor,currency,status)
        VALUES ($1,$2,$3,$4,'pending_payment') RETURNING id
      `, [identity.tenantId, subscription.id, plan.price_minor, plan.currency]);
      const { rows: [created] } = await db.query(`
        INSERT INTO commercial_billing.checkout_orders
          (tenant_id,request_key,request_hash,subscription_id,invoice_id,plan_version_id,modules,seats,amount_minor,currency)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) RETURNING *
      `, [identity.tenantId, requestKey, hash, subscription.id, invoice.id,
        planVersionId, JSON.stringify(selected), seats, plan.price_minor, plan.currency]);
      return { ...payload(created), replayed: false };
    });
  }

  async function transition({ identity, orderId, action, graceUntil }) {
    if (!validIdentity(identity) || !uuid(orderId) || !['grace', 'cancel'].includes(action) ||
      (action === 'grace' && (!Number.isFinite(Date.parse(graceUntil)) || Date.parse(graceUntil) <= now().getTime() ||
        Date.parse(graceUntil) > now().getTime() + 30 * 86_400_000))) {
      fail('INVALID_REQUEST');
    }
    if (await authorizeLifecycle({ identity, action: `billing.checkout.${action}` }) !== true) fail('FORBIDDEN');
    return transactions.run(identity.tenantId, async db => {
      const { rows: [row] } = await db.query(`
        SELECT * FROM commercial_billing.checkout_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE
      `, [identity.tenantId, orderId]);
      if (!row) fail('NOT_FOUND');
      if (row.status === 'cancelled' && action === 'cancel') return payload(row);
      if (row.status === 'cancelled' || (action === 'grace' && row.status !== 'pending_payment')) fail('CONFLICT');
      const status = action === 'grace' ? 'grace' : 'cancelled';
      const { rows: [changed] } = await db.query(`
        UPDATE commercial_billing.checkout_orders SET status = $3
        WHERE tenant_id = $1 AND id = $2 RETURNING *
      `, [identity.tenantId, orderId, status]);
      await db.query(`UPDATE commercial_billing.invoices SET status = $3
        WHERE tenant_id = $1 AND id = $2`, [identity.tenantId, row.invoice_id, status]);
      await db.query(`UPDATE commercial_billing.subscriptions SET status = $3
        WHERE tenant_id = $1 AND id = $2`, [identity.tenantId, row.subscription_id, status]);
      // Grace is a bounded billing state; it does not grant access or change the invoice amount.
      if (action === 'grace') await db.query(`
        UPDATE commercial_billing.checkout_orders SET grace_until = $3
        WHERE tenant_id = $1 AND id = $2`, [identity.tenantId, orderId, graceUntil]);
      return payload(changed);
    });
  }
  return Object.freeze({ order, transition });
}

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createTenantTransactions } from '../../../packages/data/src/tenant-transactions.mjs';

export class PaymentError extends Error {}
const fail = code => { throw new PaymentError(code); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validIdentity = identity => uuid(identity?.tenantId) && identity.scope === identity.tenantId;

export function createPaymentService({ pool, provider, webhookSecret, authorize, now = () => new Date() }) {
  if (typeof pool?.connect !== 'function' || typeof provider?.createIntent !== 'function' ||
    typeof provider?.verify !== 'function' || typeof authorize !== 'function' ||
    typeof webhookSecret !== 'string' || webhookSecret.length < 32) throw new TypeError('Payment dependencies required');
  const tx = createTenantTransactions(pool);

  async function begin({ identity, orderId, requestKey }) {
    if (!validIdentity(identity) || !uuid(orderId) || !uuid(requestKey)) fail('INVALID_REQUEST');
    if (await authorize({ identity, action: 'billing.payment.begin' }) !== true) fail('FORBIDDEN');
    return tx.run(identity.tenantId, async db => {
      const { rows: [order] } = await db.query(`SELECT * FROM commercial_billing.checkout_orders
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [identity.tenantId, orderId]);
      if (!order) fail('NOT_FOUND');
      if (order.status !== 'pending_payment' && order.status !== 'grace') fail('CONFLICT');
      const hash = createHash('sha256').update(JSON.stringify([order.invoice_id, String(order.amount_minor), order.currency])).digest('hex');
      const { rows: [prior] } = await db.query(`SELECT * FROM commercial_billing.payment_attempts
        WHERE tenant_id=$1 AND idempotency_key=$2`, [identity.tenantId, requestKey]);
      if (prior) {
        if (prior.invoice_id !== order.invoice_id || prior.request_hash !== hash) fail('CONFLICT');
        return { attemptId: prior.id, providerReference: prior.provider_reference, replayed: true };
      }
      // The adapter must use requestKey as the provider idempotency key. A retry after
      // a database rollback must return the same reference instead of a new charge.
      const intent = await provider.createIntent({ amountMinor: String(order.amount_minor), currency: order.currency,
        requestKey, invoiceId: order.invoice_id });
      if (!token(intent?.reference) || !token(provider.name)) fail('PROVIDER_INVALID');
      const { rows: [attempt] } = await db.query(`INSERT INTO commercial_billing.payment_attempts
        (tenant_id,invoice_id,idempotency_key,request_hash,status,provider,provider_reference)
        VALUES ($1,$2,$3,$4,'pending',$5,$6) RETURNING id`,
      [identity.tenantId, order.invoice_id, requestKey, hash, provider.name, intent.reference]);
      return { attemptId: attempt.id, providerReference: intent.reference, replayed: false };
    });
  }

  async function callback({ rawBody, signature, timestamp }) {
    if (!Buffer.isBuffer(rawBody) || rawBody.length > 8192 || rawBody.length === 0 ||
      !Number.isSafeInteger(timestamp) || Math.abs(now().getTime() - timestamp * 1000) > 300_000 ||
      typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) fail('INVALID_WEBHOOK');
    const expected = createHmac('sha256', webhookSecret).update(`${timestamp}.`).update(rawBody).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) fail('INVALID_SIGNATURE');
    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch { fail('INVALID_WEBHOOK'); }
    if (!uuid(event?.tenantId) || !uuid(event?.attemptId) || !token(event?.eventId) ||
      !token(event?.reference) || event.provider !== provider.name) fail('INVALID_WEBHOOK');
    // Verify with the server-side provider API; neither a signed callback nor a
    // browser redirect is sufficient evidence of settled funds.
    const verified = await provider.verify({ reference: event.reference });
    if (verified?.paid !== true || verified.reference !== event.reference ||
      !/^[0-9]+$/.test(String(verified.amountMinor)) || verified.currency !== 'IRR') fail('UNVERIFIED');
    const payloadHash = createHash('sha256').update(rawBody).digest('hex');
    return tx.run(event.tenantId, async db => {
      const { rows: [attempt] } = await db.query(`SELECT * FROM commercial_billing.payment_attempts
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [event.tenantId, event.attemptId]);
      if (!attempt || attempt.provider !== provider.name || attempt.provider_reference !== event.reference) fail('NOT_FOUND');
      const { rows: [order] } = await db.query(`SELECT * FROM commercial_billing.checkout_orders
        WHERE tenant_id=$1 AND invoice_id=$2 FOR UPDATE`, [event.tenantId, attempt.invoice_id]);
      if (!order || order.status === 'cancelled' || (order.status !== 'pending_payment' && order.status !== 'grace' && order.status !== 'paid') ||
        String(order.amount_minor) !== String(verified.amountMinor) || order.currency !== verified.currency) fail('CONFLICT');
      const { rows: [prior] } = await db.query(`SELECT payload_hash,attempt_id FROM commercial_billing.verified_callbacks
        WHERE provider=$1 AND event_id=$2`, [provider.name, event.eventId]);
      if (prior && (prior.payload_hash !== payloadHash || prior.attempt_id !== attempt.id)) fail('CONFLICT');
      if (!prior) await db.query(`INSERT INTO commercial_billing.verified_callbacks
        (provider,event_id,payload_hash,tenant_id,attempt_id) VALUES ($1,$2,$3,$4,$5)`,
      [provider.name, event.eventId, payloadHash, event.tenantId, attempt.id]);
      if (attempt.status === 'verified') return { paid: true, replayed: true };
      if (attempt.status !== 'pending' || order.status === 'paid') fail('CONFLICT');
      await db.query(`UPDATE commercial_billing.payment_attempts SET status='verified'
        WHERE tenant_id=$1 AND id=$2`, [event.tenantId, attempt.id]);
      await db.query(`UPDATE commercial_billing.checkout_orders SET status='paid'
        WHERE tenant_id=$1 AND id=$2`, [event.tenantId, order.id]);
      await db.query(`UPDATE commercial_billing.invoices SET status='paid'
        WHERE tenant_id=$1 AND id=$2`, [event.tenantId, order.invoice_id]);
      await db.query(`UPDATE commercial_billing.subscriptions SET status='active'
        WHERE tenant_id=$1 AND id=$2`, [event.tenantId, order.subscription_id]);
      await db.query(`INSERT INTO commercial_billing.ledger_entries(tenant_id,invoice_id,direction,amount_minor)
        VALUES ($1,$2,'credit',$3)`, [event.tenantId, order.invoice_id, order.amount_minor]);
      for (const feature of order.modules) await db.query(`INSERT INTO commercial_billing.entitlements
        (tenant_id,feature,source_subscription_id) VALUES ($1,$2,$3)`, [event.tenantId, feature, order.subscription_id]);
      return { paid: true, replayed: false };
    });
  }
  return Object.freeze({ begin, callback });
}

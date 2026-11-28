import { createTenantTransactions } from '../../../packages/data/src/tenant-transactions.mjs';

export class RefundError extends Error {}
const fail = code => { throw new RefundError(code); };
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
const identityOk = identity => uuid(identity?.actorId) && identity.scope === 'identity-bootstrap' && identity.mfa === true;
const view = row => ({ id: row.id, invoiceId: row.invoice_id, state: row.state,
  requestedBy: row.requested_by, firstApprover: row.approved_first_by, secondApprover: row.approved_second_by });

export function createRefundService({ pool, authorize, provider }) {
  if (typeof pool?.connect !== 'function' || typeof authorize !== 'function' || typeof provider?.refund !== 'function') {
    throw new TypeError('Platform billing policy and idempotent refund provider are required');
  }
  const tx = createTenantTransactions(pool);
  async function allowed(identity, tenantId, action) {
    if (!uuid(tenantId) || !identityOk(identity)) fail('FORBIDDEN');
    if (await authorize({ identity, tenantId, action }) !== true) fail('FORBIDDEN');
  }

  async function request({ identity, tenantId, invoiceId, requestKey }) {
    if (!uuid(invoiceId) || !uuid(requestKey)) fail('INVALID_REQUEST');
    await allowed(identity, tenantId, 'billing.refund.request');
    return tx.run(tenantId, async db => {
      const { rows: [prior] } = await db.query(`SELECT * FROM commercial_billing.refund_requests
        WHERE tenant_id=$1 AND request_key=$2`, [tenantId, requestKey]);
      if (prior) {
        if (prior.invoice_id !== invoiceId || prior.requested_by !== identity.actorId) fail('CONFLICT');
        return { ...view(prior), replayed: true };
      }
      const { rows: [invoice] } = await db.query(`SELECT * FROM commercial_billing.invoices
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, invoiceId]);
      if (!invoice || invoice.status !== 'paid') fail('NOT_FOUND');
      const { rows: [existingInvoice] } = await db.query(`SELECT 1 FROM commercial_billing.refund_requests
        WHERE tenant_id=$1 AND invoice_id=$2`, [tenantId, invoiceId]);
      if (existingInvoice) fail('CONFLICT');
      const { rows: [credit] } = await db.query(`SELECT 1 FROM commercial_billing.ledger_entries
        WHERE tenant_id=$1 AND invoice_id=$2 AND direction='credit'`, [tenantId, invoiceId]);
      if (!credit) fail('CONFLICT');
      const { rows: [created] } = await db.query(`INSERT INTO commercial_billing.refund_requests
        (tenant_id,request_key,invoice_id,requested_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [tenantId, requestKey, invoiceId, identity.actorId]);
      return { ...view(created), replayed: false };
    });
  }

  async function approve({ identity, tenantId, refundId }) {
    if (!uuid(refundId)) fail('INVALID_REQUEST');
    await allowed(identity, tenantId, 'billing.refund.approve');
    return tx.run(tenantId, async db => {
      const { rows: [row] } = await db.query(`SELECT * FROM commercial_billing.refund_requests
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, refundId]);
      if (!row) fail('NOT_FOUND');
      if (row.requested_by === identity.actorId || row.approved_first_by === identity.actorId) fail('FORBIDDEN');
      if (row.state === 'refunded') return view(row);
      if (row.state === 'pending_first') {
        const { rows: [changed] } = await db.query(`UPDATE commercial_billing.refund_requests
          SET approved_first_by=$3, approved_first_at=statement_timestamp(), state='pending_second'
          WHERE tenant_id=$1 AND id=$2 RETURNING *`, [tenantId, refundId, identity.actorId]);
        return view(changed);
      }
      const { rows: [invoice] } = await db.query(`SELECT * FROM commercial_billing.invoices
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, row.invoice_id]);
      if (!invoice || invoice.status !== 'paid') fail('CONFLICT');
      const { rows: [payment] } = await db.query(`SELECT provider_reference,provider FROM commercial_billing.payment_attempts
        WHERE tenant_id=$1 AND invoice_id=$2 AND status='verified' ORDER BY id LIMIT 1`, [tenantId, row.invoice_id]);
      if (!payment?.provider_reference || payment.provider !== provider.name) fail('CONFLICT');
      // Provider.refund must deduplicate on refundId, including after a DB rollback.
      const receipt = await provider.refund({ paymentReference: payment.provider_reference,
        amountMinor: String(invoice.amount_minor), currency: invoice.currency, idempotencyKey: refundId });
      if (receipt?.refunded !== true || typeof receipt.reference !== 'string' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.reference)) fail('UNVERIFIED');
      await db.query(`INSERT INTO commercial_billing.ledger_entries(tenant_id,invoice_id,direction,amount_minor)
        VALUES ($1,$2,'debit',$3)`, [tenantId, row.invoice_id, invoice.amount_minor]);
      await db.query(`UPDATE commercial_billing.invoices SET status='refunded'
        WHERE tenant_id=$1 AND id=$2`, [tenantId, row.invoice_id]);
      await db.query(`UPDATE commercial_billing.checkout_orders SET status='refunded'
        WHERE tenant_id=$1 AND invoice_id=$2`, [tenantId, row.invoice_id]);
      await db.query(`UPDATE commercial_billing.subscriptions SET status='cancelled'
        WHERE tenant_id=$1 AND id=$2`, [tenantId, invoice.subscription_id]);
      await db.query(`UPDATE commercial_billing.entitlements SET valid_to=statement_timestamp()
        WHERE tenant_id=$1 AND source_subscription_id=$2 AND (valid_to IS NULL OR valid_to > statement_timestamp())`,
      [tenantId, invoice.subscription_id]);
      const { rows: [changed] } = await db.query(`UPDATE commercial_billing.refund_requests
        SET approved_second_by=$3, approved_second_at=statement_timestamp(),
          provider_refund_reference=$4, state='refunded'
        WHERE tenant_id=$1 AND id=$2 RETURNING *`, [tenantId, refundId, identity.actorId, receipt.reference]);
      return view(changed);
    });
  }

  async function dashboard({ identity, tenantIds }) {
    if (!Array.isArray(tenantIds) || tenantIds.length > 100 || new Set(tenantIds).size !== tenantIds.length) fail('INVALID_REQUEST');
    const totals = [];
    for (const tenantId of tenantIds) {
      await allowed(identity, tenantId, 'billing.report.read');
      const result = await tx.run(tenantId, async db => {
        const { rows: [row] } = await db.query(`SELECT
          COALESCE(sum(amount_minor) FILTER (WHERE direction='credit'),0)::text AS gross,
          COALESCE(sum(amount_minor) FILTER (WHERE direction='debit'),0)::text AS refunded,
          count(*) FILTER (WHERE direction='credit')::integer AS payments
          FROM commercial_billing.ledger_entries WHERE tenant_id=$1`, [tenantId]);
        return { tenantId, grossMinor: row.gross, refundedMinor: row.refunded,
          netMinor: (BigInt(row.gross) - BigInt(row.refunded)).toString(), payments: row.payments };
      });
      totals.push(result);
    }
    return totals;
  }

  async function reconcile({ identity, tenantId }) {
    await allowed(identity, tenantId, 'billing.reconcile.read');
    return tx.run(tenantId, async db => {
      const { rows } = await db.query(`SELECT i.id, i.status, i.amount_minor,
        count(l.id) FILTER (WHERE l.direction='credit')::integer AS credits,
        count(l.id) FILTER (WHERE l.direction='debit')::integer AS debits,
        count(p.id) FILTER (WHERE p.status='verified')::integer AS verified_attempts,
        max(r.state) AS refund_state
        FROM commercial_billing.invoices i
        LEFT JOIN commercial_billing.ledger_entries l ON l.tenant_id=i.tenant_id AND l.invoice_id=i.id
        LEFT JOIN commercial_billing.payment_attempts p ON p.tenant_id=i.tenant_id AND p.invoice_id=i.id
        LEFT JOIN commercial_billing.refund_requests r ON r.tenant_id=i.tenant_id AND r.invoice_id=i.id
        WHERE i.tenant_id=$1 GROUP BY i.tenant_id,i.id ORDER BY i.id LIMIT 1000`, [tenantId]);
      // Aggregate joins can multiply counts, so only existence is compared. This
      // read-only report never repairs a ledger silently.
      return rows.filter(row => (row.status === 'paid' && (!row.credits || !row.verified_attempts || row.debits)) ||
        (row.status === 'refunded' && (!row.credits || !row.debits || row.refund_state !== 'refunded')))
        .map(row => ({ invoiceId: row.id, status: row.status, reason: 'LEDGER_OR_PROVIDER_MISMATCH' }));
    });
  }
  return Object.freeze({ request, approve, dashboard, reconcile });
}

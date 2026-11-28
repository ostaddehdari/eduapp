import { createTenantTransactions } from '../../../packages/data/src/tenant-transactions.mjs';

export class DelegationError extends Error {}
const fail = code => { throw new DelegationError(code); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const valid = identity => uuid(identity?.tenantId) && identity.scope === identity.tenantId && uuid(identity.actorId);
const view = row => ({ id: row.id, subscriptionId: row.subscription_id, delegateIdentityId: row.delegate_identity_id,
  scopeOrgId: row.scope_org_id, expiresAt: row.expires_at, approvedAt: row.approved_at, revokedAt: row.revoked_at });

export function createDelegationService({ pool, resolveOwner, scopeExists, authorizePurchase, authorizeOwner, now = () => new Date() }) {
  if (typeof pool?.connect !== 'function' || typeof resolveOwner !== 'function' ||
    typeof scopeExists !== 'function' || typeof authorizePurchase !== 'function' ||
    typeof authorizeOwner !== 'function') throw new TypeError('Delegation policies required');
  const tx = createTenantTransactions(pool);

  async function request({ identity, subscriptionId, delegateIdentityId, scopeOrgId, expiresAt, requestKey }) {
    const expiry = Date.parse(expiresAt);
    if (!valid(identity) || ![subscriptionId, delegateIdentityId, scopeOrgId, requestKey].every(uuid) ||
      identity.actorId === delegateIdentityId || !Number.isFinite(expiry) ||
      expiry <= now().getTime() || expiry > now().getTime() + 366 * 86_400_000) fail('INVALID_REQUEST');
    if (await authorizePurchase({ identity, action: 'billing.delegation.request' }) !== true) fail('FORBIDDEN');
    const ownerId = await resolveOwner({ tenantId: identity.tenantId });
    if (!uuid(ownerId) || ownerId === delegateIdentityId ||
      await scopeExists({ tenantId: identity.tenantId, scopeOrgId }) !== true) fail('NOT_FOUND');
    return tx.run(identity.tenantId, async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 10506))',
        [identity.tenantId + ':' + subscriptionId]);
      const { rows: [prior] } = await db.query(`SELECT * FROM commercial_billing.management_delegations
        WHERE tenant_id=$1 AND request_key=$2`, [identity.tenantId, requestKey]);
      if (prior) {
        if (prior.subscription_id !== subscriptionId || prior.delegate_identity_id !== delegateIdentityId ||
          prior.scope_org_id !== scopeOrgId || prior.owner_identity_id !== ownerId ||
          new Date(prior.expires_at).getTime() !== expiry) fail('CONFLICT');
        return { ...view(prior), replayed: true };
      }
      const { rows: [seat] } = await db.query(`SELECT o.seats FROM commercial_billing.checkout_orders o
        JOIN commercial_billing.subscriptions s ON s.tenant_id=o.tenant_id AND s.id=o.subscription_id
        WHERE o.tenant_id=$1 AND o.subscription_id=$2 AND o.status='paid' AND s.status='active'`,
      [identity.tenantId, subscriptionId]);
      if (!seat) fail('FORBIDDEN');
      const { rows: [usage] } = await db.query(`SELECT count(*)::integer AS occupied
        FROM commercial_billing.management_delegations WHERE tenant_id=$1 AND subscription_id=$2
          AND revoked_at IS NULL AND expires_at > $3`, [identity.tenantId, subscriptionId, now()]);
      if (usage.occupied >= seat.seats) fail('SEATS_EXHAUSTED');
      const { rows: [created] } = await db.query(`INSERT INTO commercial_billing.management_delegations
        (tenant_id,request_key,subscription_id,owner_identity_id,delegate_identity_id,scope_org_id,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [identity.tenantId, requestKey, subscriptionId, ownerId, delegateIdentityId, scopeOrgId, expiresAt]);
      return { ...view(created), replayed: false };
    });
  }

  async function decide({ identity, delegationId, action }) {
    if (!valid(identity) || !uuid(delegationId) || !['approve', 'revoke'].includes(action)) fail('INVALID_REQUEST');
    const ownerId = await resolveOwner({ tenantId: identity.tenantId });
    if (identity.actorId !== ownerId ||
      await authorizeOwner({ identity, action: `billing.delegation.${action}` }) !== true) fail('FORBIDDEN');
    return tx.run(identity.tenantId, async db => {
      const { rows: [row] } = await db.query(`SELECT * FROM commercial_billing.management_delegations
        WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [identity.tenantId, delegationId]);
      if (!row) fail('NOT_FOUND');
      if (row.owner_identity_id !== ownerId || row.expires_at <= now()) fail('CONFLICT');
      if (action === 'approve' && (row.approved_at || row.revoked_at)) fail('CONFLICT');
      if (action === 'revoke' && !row.approved_at) fail('CONFLICT');
      if (action === 'revoke' && row.revoked_at) return view(row);
      const column = action === 'approve' ? 'approved_at' : 'revoked_at';
      const { rows: [changed] } = await db.query(`UPDATE commercial_billing.management_delegations
        SET ${column}=statement_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
      [identity.tenantId, delegationId]);
      return view(changed);
    });
  }

  // The management authorization path must call this on every sensitive action;
  // a paid subscription alone never creates an IAM membership or role binding.
  async function canManage({ identity, scopeOrgId }) {
    if (!valid(identity) || !uuid(scopeOrgId)) return false;
    return tx.run(identity.tenantId, async db => {
      const { rows: [found] } = await db.query(`SELECT 1 FROM commercial_billing.management_delegations d
        JOIN commercial_billing.subscriptions s ON s.tenant_id=d.tenant_id AND s.id=d.subscription_id
        WHERE d.tenant_id=$1 AND d.delegate_identity_id=$2 AND d.scope_org_id=$3
          AND d.approved_at IS NOT NULL AND d.revoked_at IS NULL AND d.expires_at > $4 AND s.status='active'
        LIMIT 1`, [identity.tenantId, identity.actorId, scopeOrgId, now()]);
      return Boolean(found);
    });
  }
  return Object.freeze({ request, decide, canManage });
}

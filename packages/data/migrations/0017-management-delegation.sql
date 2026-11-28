SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_commercial_billing_owner;

-- Purchasing a seat creates no role binding. The owner must approve the specific
-- identity and scope, and every management decision checks this live record.
CREATE TABLE commercial_billing.management_delegations (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_key uuid NOT NULL,
  subscription_id uuid NOT NULL,
  owner_identity_id uuid NOT NULL,
  delegate_identity_id uuid NOT NULL,
  scope_org_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, request_key),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES commercial_billing.subscriptions(tenant_id, id),
  CHECK (owner_identity_id <> delegate_identity_id),
  CHECK (expires_at > created_at),
  CHECK (approved_at IS NULL OR approved_at >= created_at),
  CHECK (revoked_at IS NULL OR approved_at IS NOT NULL)
);
ALTER TABLE commercial_billing.management_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing.management_delegations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON commercial_billing.management_delegations AS RESTRICTIVE
  USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON commercial_billing.management_delegations USING (true) WITH CHECK (true);
GRANT SELECT ON commercial_billing.management_delegations TO eduapp_billing_api;
GRANT INSERT (tenant_id, request_key, subscription_id, owner_identity_id, delegate_identity_id, scope_org_id, expires_at)
  ON commercial_billing.management_delegations TO eduapp_billing_api;
GRANT UPDATE (approved_at, revoked_at) ON commercial_billing.management_delegations TO eduapp_billing_api;
CREATE INDEX management_delegation_live ON commercial_billing.management_delegations
  (tenant_id, delegate_identity_id, scope_org_id, expires_at) WHERE approved_at IS NOT NULL AND revoked_at IS NULL;
RESET ROLE;

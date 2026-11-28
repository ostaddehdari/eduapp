SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_commercial_billing_owner;

-- Orders are immutable snapshots of a selected published version. Payment confirmation
-- and subscription activation are deliberately outside this migration.
CREATE TABLE commercial_billing.checkout_orders (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  subscription_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  plan_version_id uuid NOT NULL REFERENCES commercial_billing.plan_versions(id),
  modules jsonb NOT NULL CHECK (jsonb_typeof(modules) = 'array'),
  seats integer NOT NULL CHECK (seats BETWEEN 1 AND 1000000),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency = 'IRR'),
  status text NOT NULL DEFAULT 'pending_payment' CHECK (status IN ('pending_payment', 'grace', 'cancelled')),
  grace_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, request_key),
  FOREIGN KEY (tenant_id, subscription_id) REFERENCES commercial_billing.subscriptions(tenant_id,id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES commercial_billing.invoices(tenant_id,id)
);
ALTER TABLE commercial_billing.checkout_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing.checkout_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON commercial_billing.checkout_orders AS RESTRICTIVE
  USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON commercial_billing.checkout_orders USING (true) WITH CHECK (true);
GRANT SELECT ON commercial_billing.checkout_orders TO eduapp_billing_api;
GRANT INSERT (tenant_id,request_key,request_hash,subscription_id,invoice_id,plan_version_id,modules,seats,amount_minor,currency)
  ON commercial_billing.checkout_orders TO eduapp_billing_api;
GRANT UPDATE (status, grace_until) ON commercial_billing.checkout_orders TO eduapp_billing_api;
-- Existing invoices and subscriptions remain; cancellation never deletes them.
RESET ROLE;

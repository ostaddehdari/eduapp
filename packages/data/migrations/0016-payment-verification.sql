SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_commercial_billing_owner;

-- A provider event is evidence, never an instruction to credit an arbitrary tenant.
ALTER TABLE commercial_billing.payment_attempts
  ADD COLUMN provider text,
  ADD COLUMN provider_reference text,
  ADD CONSTRAINT payment_provider_pair CHECK ((provider IS NULL) = (provider_reference IS NULL));
CREATE UNIQUE INDEX payment_provider_reference ON commercial_billing.payment_attempts(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
GRANT UPDATE (provider, provider_reference) ON commercial_billing.payment_attempts TO eduapp_billing_api;
ALTER TABLE commercial_billing.checkout_orders DROP CONSTRAINT checkout_orders_status_check;
ALTER TABLE commercial_billing.checkout_orders ADD CONSTRAINT checkout_orders_status_check
  CHECK (status IN ('pending_payment', 'grace', 'cancelled', 'paid'));

CREATE TABLE commercial_billing.verified_callbacks (
  provider text NOT NULL,
  event_id text NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (provider, event_id),
  FOREIGN KEY (tenant_id, attempt_id) REFERENCES commercial_billing.payment_attempts(tenant_id, id)
);
ALTER TABLE commercial_billing.verified_callbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing.verified_callbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON commercial_billing.verified_callbacks AS RESTRICTIVE
  USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON commercial_billing.verified_callbacks USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON commercial_billing.verified_callbacks TO eduapp_billing_api;

-- A subscription can be credited once; retries may record distinct callback evidence.
CREATE UNIQUE INDEX ledger_one_credit_per_invoice ON commercial_billing.ledger_entries(tenant_id, invoice_id)
  WHERE direction = 'credit';
CREATE UNIQUE INDEX entitlement_one_source_feature ON commercial_billing.entitlements(tenant_id, source_subscription_id, feature)
  WHERE source_subscription_id IS NOT NULL;
RESET ROLE;

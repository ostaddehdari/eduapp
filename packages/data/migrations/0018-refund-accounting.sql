SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_commercial_billing_owner;

-- Full refunds require two distinct approvers besides the requester. The original
-- credit is immutable; a verified refund adds exactly one compensating debit.
CREATE TABLE commercial_billing.refund_requests (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  request_key uuid NOT NULL,
  invoice_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  approved_first_by uuid,
  approved_second_by uuid,
  provider_refund_reference text,
  state text NOT NULL DEFAULT 'pending_first' CHECK (state IN ('pending_first','pending_second','refunded')),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  approved_first_at timestamptz,
  approved_second_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,request_key),
  UNIQUE (tenant_id,invoice_id),
  FOREIGN KEY (tenant_id,invoice_id) REFERENCES commercial_billing.invoices(tenant_id,id),
  CHECK (approved_first_by IS NULL OR approved_first_by <> requested_by),
  CHECK (approved_second_by IS NULL OR (approved_second_by <> requested_by AND approved_second_by <> approved_first_by)),
  CHECK ((state = 'pending_first' AND approved_first_by IS NULL AND approved_second_by IS NULL)
    OR (state = 'pending_second' AND approved_first_by IS NOT NULL AND approved_second_by IS NULL)
    OR (state = 'refunded' AND approved_first_by IS NOT NULL AND approved_second_by IS NOT NULL
      AND provider_refund_reference IS NOT NULL))
);
ALTER TABLE commercial_billing.refund_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing.refund_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON commercial_billing.refund_requests AS RESTRICTIVE
  USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON commercial_billing.refund_requests USING (true) WITH CHECK (true);
GRANT SELECT ON commercial_billing.refund_requests TO eduapp_billing_api;
GRANT INSERT (tenant_id,request_key,invoice_id,requested_by) ON commercial_billing.refund_requests TO eduapp_billing_api;
GRANT UPDATE (approved_first_by,approved_first_at,approved_second_by,approved_second_at,provider_refund_reference,state)
  ON commercial_billing.refund_requests TO eduapp_billing_api;
CREATE UNIQUE INDEX ledger_one_debit_per_invoice ON commercial_billing.ledger_entries(tenant_id,invoice_id)
  WHERE direction='debit';
ALTER TABLE commercial_billing.checkout_orders DROP CONSTRAINT checkout_orders_status_check;
ALTER TABLE commercial_billing.checkout_orders ADD CONSTRAINT checkout_orders_status_check
  CHECK (status IN ('pending_payment','grace','cancelled','paid','refunded'));
RESET ROLE;

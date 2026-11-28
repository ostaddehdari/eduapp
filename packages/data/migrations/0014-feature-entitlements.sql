SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_commercial_billing_owner;

-- Existing unsourced grants are deliberately not treated as paid entitlements.
ALTER TABLE commercial_billing.entitlements
  ADD COLUMN source_subscription_id uuid,
  ADD COLUMN valid_from timestamptz NOT NULL DEFAULT statement_timestamp(),
  ADD CONSTRAINT entitlement_subscription
    FOREIGN KEY (tenant_id, source_subscription_id)
    REFERENCES commercial_billing.subscriptions (tenant_id, id);

CREATE TABLE commercial_billing.feature_flags (
  feature text PRIMARY KEY CHECK (feature ~ '^[a-z][a-z0-9_]{1,47}$'),
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0)
);
GRANT SELECT ON commercial_billing.feature_flags TO eduapp_billing_api;

CREATE TABLE commercial_billing.usage_counters (
  tenant_id uuid NOT NULL,
  feature text NOT NULL REFERENCES commercial_billing.feature_flags(feature),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (tenant_id, feature, period)
);
ALTER TABLE commercial_billing.usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing.usage_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON commercial_billing.usage_counters AS RESTRICTIVE
  USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON commercial_billing.usage_counters USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE (used) ON commercial_billing.usage_counters TO eduapp_billing_api;

CREATE TABLE commercial_billing.usage_requests (
  tenant_id uuid NOT NULL,
  request_key uuid NOT NULL,
  feature text NOT NULL,
  period text NOT NULL,
  amount bigint NOT NULL CHECK (amount > 0),
  used_after bigint NOT NULL CHECK (used_after >= amount),
  PRIMARY KEY (tenant_id, request_key)
);
ALTER TABLE commercial_billing.usage_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_billing.usage_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_guard ON commercial_billing.usage_requests AS RESTRICTIVE
  USING (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY granted_operation ON commercial_billing.usage_requests USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON commercial_billing.usage_requests TO eduapp_billing_api;

RESET ROLE;

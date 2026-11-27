SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_commercial_billing_owner;

ALTER TABLE commercial_billing.plans
  ADD COLUMN status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived'));

ALTER TABLE commercial_billing.plan_versions
  ADD COLUMN version integer CHECK (version > 0),
  ADD COLUMN modules jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(modules) = 'array'),
  ADD COLUMN quotas jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(quotas) = 'object'),
  ADD COLUMN trial_days integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 90),
  ADD COLUMN term_days integer NOT NULL DEFAULT 365 CHECK (term_days BETWEEN 1 AND 366),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  ADD CONSTRAINT plan_version_number UNIQUE (plan_id, version);

-- Existing plan versions remain readable to existing subscribers, but cannot
-- accidentally become purchasable without a reviewed data migration.
CREATE TABLE commercial_billing.discount_codes (
  code text PRIMARY KEY CHECK (code ~ '^[A-Z0-9_-]{4,32}$'),
  plan_id uuid NOT NULL REFERENCES commercial_billing.plans(id),
  percentage integer NOT NULL CHECK (percentage BETWEEN 1 AND 100),
  valid_from timestamptz NOT NULL,
  valid_to timestamptz NOT NULL CHECK (valid_to > valid_from),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
GRANT SELECT ON commercial_billing.discount_codes TO eduapp_billing_api;
GRANT INSERT (code, plan_id, percentage, valid_from, valid_to)
  ON commercial_billing.discount_codes TO eduapp_billing_api;
GRANT INSERT (code, status) ON commercial_billing.plans TO eduapp_billing_api;
GRANT INSERT (plan_id, version, price_minor, currency, effective_at, modules, quotas, trial_days, term_days)
  ON commercial_billing.plan_versions TO eduapp_billing_api;
-- Neither the runtime nor a customer can rewrite a published offer or discount.
REVOKE UPDATE, DELETE ON commercial_billing.plans, commercial_billing.plan_versions,
  commercial_billing.discount_codes FROM eduapp_billing_api;
RESET ROLE;

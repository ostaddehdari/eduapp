SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_identity_access_owner;

ALTER TABLE identity_access.sessions
    ADD COLUMN mfa_verified_at timestamptz,
    ADD COLUMN mfa_session_revision integer,
    ADD COLUMN mfa_factor_revision integer,
    ADD CONSTRAINT mfa_proof_complete CHECK (
        (mfa_verified_at IS NULL AND mfa_session_revision IS NULL AND mfa_factor_revision IS NULL)
        OR (mfa_verified_at IS NOT NULL AND mfa_session_revision IS NOT NULL AND mfa_factor_revision IS NOT NULL)
    );

ALTER TABLE identity_access.session_revocations
    DROP CONSTRAINT session_revocations_reason_check,
    ADD CONSTRAINT session_revocations_reason_check CHECK (reason IN ('logout', 'refresh_reuse', 'mfa_recovery'));

CREATE TABLE identity_access.mfa_factors (
    identity_id uuid PRIMARY KEY REFERENCES identity_access.identities (id) ON DELETE CASCADE,
    encrypted_seed text NOT NULL,
    last_counter bigint NOT NULL CHECK (last_counter >= 0),
    revision integer NOT NULL CHECK (revision > 0)
);
GRANT SELECT, INSERT, UPDATE ON identity_access.mfa_factors TO eduapp_iam_api;

CREATE TABLE identity_access.mfa_recovery_codes (
    identity_id uuid NOT NULL REFERENCES identity_access.mfa_factors (identity_id) ON DELETE CASCADE,
    digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    used_at timestamptz,
    PRIMARY KEY (identity_id, digest)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_access.mfa_recovery_codes TO eduapp_iam_api;

CREATE TABLE identity_access.mfa_actions (
    id uuid PRIMARY KEY,
    identity_id uuid NOT NULL REFERENCES identity_access.identities (id) ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES identity_access.sessions (id) ON DELETE CASCADE,
    session_revision integer NOT NULL CHECK (session_revision > 0),
    purpose text NOT NULL CHECK (purpose IN ('enrollment', 'recovery')),
    encrypted_seed text NOT NULL,
    token_digest text CHECK (token_digest ~ '^[0-9a-f]{64}$'),
    expected_factor_revision integer,
    expires_at timestamptz NOT NULL,
    completed_at timestamptz,
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    CHECK (
        (purpose = 'recovery' AND expected_factor_revision IS NOT NULL
            AND expected_factor_revision > 0 AND token_digest IS NOT NULL)
        OR (purpose = 'enrollment' AND expected_factor_revision IS NULL AND token_digest IS NULL)
    )
);
CREATE INDEX mfa_actions_expiry ON identity_access.mfa_actions (expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_access.mfa_actions TO eduapp_iam_api;

CREATE TABLE identity_access.mfa_audit_facts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    identity_id uuid NOT NULL,
    session_id uuid NOT NULL,
    tenant_id uuid,
    membership_id uuid,
    event_type text NOT NULL CHECK (event_type IN (
        'identity.mfa_enrolled.v1',
        'identity.mfa_step_up.v1',
        'identity.mfa_recovery_started.v1',
        'identity.mfa_recovered.v1'
    )),
    occurred_at timestamptz NOT NULL,
    CHECK ((tenant_id IS NULL) = (membership_id IS NULL))
);
GRANT SELECT, INSERT ON identity_access.mfa_audit_facts TO eduapp_iam_api;

RESET ROLE;

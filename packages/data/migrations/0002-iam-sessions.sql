SET LOCAL search_path = pg_catalog;
SET LOCAL ROLE eduapp_identity_access_owner;

ALTER TABLE identity_access.identities ADD COLUMN password_hash text
    CHECK (password_hash ~ '^scrypt-v1[$][0-9a-f]{32}[$][0-9a-f]{64}$');

ALTER TABLE identity_access.sessions
    ADD COLUMN access_hash text UNIQUE CHECK (access_hash ~ '^[0-9a-f]{64}$'),
    ADD COLUMN access_expires_at timestamptz,
    ADD COLUMN tenant_id uuid,
    ADD COLUMN membership_id uuid,
    ADD COLUMN issued_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    ADD CONSTRAINT session_scope_complete CHECK ((tenant_id IS NULL) = (membership_id IS NULL)),
    ADD CONSTRAINT session_access_complete CHECK ((access_hash IS NULL) = (access_expires_at IS NULL)),
    ADD CONSTRAINT session_refresh_digest CHECK (access_hash IS NULL OR refresh_hash ~ '^[0-9a-f]{64}$');

CREATE INDEX session_actor_scope ON identity_access.sessions (identity_id, tenant_id, issued_at DESC, id DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE identity_access.otp_challenges (
    id uuid PRIMARY KEY,
    identity_id uuid REFERENCES identity_access.identities (id) ON DELETE CASCADE,
    tenant_id uuid,
    membership_id uuid,
    code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL,
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    consumed_at timestamptz,
    CONSTRAINT otp_membership_needs_tenant CHECK (membership_id IS NULL OR tenant_id IS NOT NULL)
);
CREATE INDEX otp_expires_at ON identity_access.otp_challenges (expires_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_access.otp_challenges TO eduapp_iam_api;

CREATE TABLE identity_access.auth_attempts (
    action text NOT NULL,
    subject_hash text NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
    window_started_at timestamptz NOT NULL,
    attempts integer NOT NULL CHECK (attempts > 0),
    PRIMARY KEY (action, subject_hash)
);
CREATE INDEX auth_attempt_window ON identity_access.auth_attempts (window_started_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON identity_access.auth_attempts TO eduapp_iam_api;

CREATE TABLE identity_access.refresh_history (
    session_id uuid NOT NULL REFERENCES identity_access.sessions (id) ON DELETE CASCADE,
    refresh_hash text NOT NULL CHECK (refresh_hash ~ '^[0-9a-f]{64}$'),
    PRIMARY KEY (session_id, refresh_hash)
);
GRANT SELECT, INSERT ON identity_access.refresh_history TO eduapp_iam_api;

CREATE TABLE identity_access.session_revocations (
    session_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision > 0),
    event_type text NOT NULL DEFAULT 'identity.session_revoked.v1'
        CHECK (event_type = 'identity.session_revoked.v1'),
    reason text NOT NULL CHECK (reason IN ('logout', 'refresh_reuse')),
    occurred_at timestamptz NOT NULL,
    PRIMARY KEY (session_id, revision)
);
GRANT SELECT, INSERT ON identity_access.session_revocations TO eduapp_iam_api;

RESET ROLE;

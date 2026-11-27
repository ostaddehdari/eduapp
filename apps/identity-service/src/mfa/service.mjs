import { randomBytes, randomUUID } from 'node:crypto';
import {
  UUID, digest, isPasswordInput, privateFingerprint, verifyPassword,
} from '../auth/crypto.mjs';
import { asDate, countAttempt, createAuthRepository } from '../auth/repository.mjs';
import { AuthError } from '../auth/service.mjs';
import {
  RECOVERY_CODE_PATTERN, TOTP_PATTERN, enrollmentMaterial, generateRecoveryCodes, matchingCounter,
  protectSeed, unprotectSeed,
} from './crypto.mjs';

const STEP_UP_WINDOW = 5 * 60_000;
const ACTION_WINDOW = 10 * 60_000;
const ATTEMPT_WINDOW = 15 * 60_000;
const CHALLENGE_ATTEMPTS = 5;
const invalid = () => new AuthError('VALIDATION_FAILED');
const unauthorized = () => new AuthError('AUTHENTICATION_REQUIRED');
const isUuid = (value) => typeof value === 'string' && UUID.test(value);
const hasCurrentContext = (identity) => isUuid(identity?.sessionId) && isUuid(identity.identityId) &&
  Number.isSafeInteger(identity.sessionRevision) && identity.sessionRevision > 0;
const sameContext = (identity, session) => (identity.tenantId ?? null) === session.tenant_id &&
  (identity.membershipId ?? null) === session.membership_id;

async function lockCurrentSession(db, identity, instant) {
  if (!hasCurrentContext(identity)) throw unauthorized();
  const { rows: [session] } = await db.query(`
    SELECT s.id, s.identity_id, s.tenant_id, s.membership_id, s.revision, i.password_hash
    FROM identity_access.sessions AS s JOIN identity_access.identities AS i ON i.id = s.identity_id
    WHERE s.id = $1 AND s.identity_id = $2 AND s.revision = $3
      AND s.revoked_at IS NULL AND s.expires_at > $4 AND s.access_expires_at > $4
      AND i.status = 'active'
    FOR UPDATE OF i, s
  `, [identity.sessionId, identity.identityId, identity.sessionRevision, asDate(instant)]);
  if (!session || !sameContext(identity, session)) throw unauthorized();
  return session;
}

async function audit(db, session, event, instant) {
  await db.query(`
    INSERT INTO identity_access.mfa_audit_facts
      (identity_id, session_id, tenant_id, membership_id, event_type, occurred_at)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [session.identity_id, session.id, session.tenant_id, session.membership_id, event, asDate(instant)]);
}

async function replaceRecoveryCodes(db, identityId) {
  const codes = generateRecoveryCodes();
  await db.query('DELETE FROM identity_access.mfa_recovery_codes WHERE identity_id = $1', [identityId]);
  await db.query(`
    INSERT INTO identity_access.mfa_recovery_codes (identity_id, digest)
    SELECT $1, candidate FROM unnest($2::text[]) AS candidate
  `, [identityId, codes.map(digest)]);
  return codes;
}

async function revokeAllSessions(db, identityId, instant) {
  await db.query(`
    WITH revoked AS (
      UPDATE identity_access.sessions
      SET revoked_at = $2, revision = revision + 1, access_hash = NULL, access_expires_at = NULL
      WHERE identity_id = $1 AND revoked_at IS NULL
      RETURNING id, revision
    )
    INSERT INTO identity_access.session_revocations (session_id, revision, reason, occurred_at)
    SELECT id, revision, 'mfa_recovery', $2 FROM revoked
  `, [identityId, asDate(instant)]);
}

function decodeRecoveryTicket(value) {
  if (typeof value !== 'string' || !value.startsWith('mfar1.')) return null;
  const [, id, secret, ...extra] = value.split('.');
  return isUuid(id) && /^[A-Za-z0-9_-]{43}$/.test(secret ?? '') && !extra.length
    ? { id, hash: digest(value) }
    : null;
}

export function createMfaService({ pool, encryptionKey, otpPepper, allowPlatformStepUp, now = Date.now }) {
  if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32 ||
      !Buffer.isBuffer(otpPepper) || otpPepper.length < 32 || encryptionKey.equals(otpPepper)) {
    throw new TypeError('MFA requires a distinct 32-byte encryption key and OTP pepper');
  }
  const key = Buffer.from(encryptionKey);
  const attemptsKey = Buffer.from(otpPepper);
  const repo = createAuthRepository(pool);

  async function canStepUp(identity) {
    if (!hasCurrentContext(identity)) return false;
    if (isUuid(identity.tenantId) && isUuid(identity.membershipId)) return true;
    return identity.tenantId === null && identity.membershipId === null &&
      await allowPlatformStepUp?.(identity) === true;
  }

  async function rateLimit(identity, action, attempts) {
    if (!hasCurrentContext(identity)) throw unauthorized();
    const retryAfter = await countAttempt(repo, action, privateFingerprint(attemptsKey, action, identity.identityId),
      now(), ATTEMPT_WINDOW, attempts);
    if (retryAfter !== null) throw new AuthError('RATE_LIMITED', retryAfter);
  }

  async function verifyPrimaryPassword(identity, password, action) {
    if (!isPasswordInput(password)) throw invalid();
    await rateLimit(identity, action, 4);
    const { rows: [user] } = await repo.query(`
      SELECT password_hash FROM identity_access.identities WHERE id = $1 AND status = 'active'
    `, [identity.identityId]);
    if (!await verifyPassword(password, user?.password_hash)) throw invalid();
    return user.password_hash;
  }

  async function startAction(db, session, purpose, expectedRevision, instant) {
    const id = randomUUID();
    const { seed, secret } = enrollmentMaterial();
    const recoveryToken = purpose === 'recovery' ? `mfar1.${id}.${randomBytes(32).toString('base64url')}` : null;
    const expiresAt = asDate(instant + ACTION_WINDOW);
    await db.query(`
      INSERT INTO identity_access.mfa_actions
        (id, identity_id, session_id, session_revision, purpose, encrypted_seed,
         token_digest, expected_factor_revision, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [id, session.identity_id, session.id, session.revision, purpose, protectSeed(key, session.identity_id, seed),
      recoveryToken && digest(recoveryToken), expectedRevision, expiresAt]);
    const otpauthUri = 'otpauth://totp/' + encodeURIComponent('EduApp:' + session.identity_id) +
      '?secret=' + secret + '&issuer=EduApp&algorithm=SHA1&digits=6&period=30';
    return recoveryToken ? { recoveryToken, secret, otpauthUri, expiresAt } : { challengeId: id, secret, otpauthUri, expiresAt };
  }

  async function readAction(db, session, id, purpose, tokenDigest, instant) {
    const { rows: [record] } = await db.query(`
      SELECT * FROM identity_access.mfa_actions
      WHERE id = $1 AND identity_id = $2 AND session_id = $3 AND session_revision = $4
        AND purpose = $5 AND token_digest IS NOT DISTINCT FROM $6::text
        AND completed_at IS NULL AND expires_at > $7 AND attempts < $8
      FOR UPDATE
    `, [id, session.identity_id, session.id, session.revision, purpose, tokenDigest, asDate(instant), CHALLENGE_ATTEMPTS]);
    return record ?? null;
  }

  async function tryPendingFactor(db, session, action, code, instant) {
    const counter = matchingCounter(unprotectSeed(key, session.identity_id, action.encrypted_seed), code, instant);
    await db.query(`
      UPDATE identity_access.mfa_actions SET attempts = attempts + 1,
        completed_at = CASE WHEN $2 THEN $3 ELSE completed_at END WHERE id = $1
    `, [action.id, counter !== null, asDate(instant)]);
    return counter;
  }

  function needCode(code) {
    if (typeof code !== 'string' || !TOTP_PATTERN.test(code)) throw invalid();
  }

  return Object.freeze({
    async beginEnrollment(identity, { password }) {
      const passwordHash = await verifyPrimaryPassword(identity, password, 'mfa_enrollment');
      const outcome = await repo.transaction(async (db) => {
        const instant = now();
        const session = await lockCurrentSession(db, identity, instant);
        const factor = await db.query('SELECT 1 FROM identity_access.mfa_factors WHERE identity_id = $1', [session.identity_id]);
        return session.password_hash === passwordHash && factor.rowCount === 0
          ? startAction(db, session, 'enrollment', null, instant)
          : null;
      });
      if (!outcome) throw invalid();
      return outcome;
    },

    async confirmEnrollment(identity, { challengeId, code }) {
      if (!isUuid(challengeId)) throw invalid();
      needCode(code);
      const outcome = await repo.transaction(async (db) => {
        const instant = now();
        const session = await lockCurrentSession(db, identity, instant);
        const action = await readAction(db, session, challengeId, 'enrollment', null, instant);
        if (!action) return null;
        const counter = await tryPendingFactor(db, session, action, code, instant);
        if (counter === null) return null;
        const inserted = await db.query(`
          INSERT INTO identity_access.mfa_factors (identity_id, encrypted_seed, last_counter, revision)
          VALUES ($1,$2,$3,1) ON CONFLICT (identity_id) DO NOTHING
        `, [session.identity_id, action.encrypted_seed, counter]);
        if (inserted.rowCount !== 1) return null;
        const recoveryCodes = await replaceRecoveryCodes(db, session.identity_id);
        await audit(db, session, 'identity.mfa_enrolled.v1', instant);
        return { recoveryCodes };
      });
      if (!outcome) throw invalid();
      return outcome;
    },

    async stepUp(identity, { code }) {
      needCode(code);
      if (!await canStepUp(identity)) throw unauthorized();
      await rateLimit(identity, 'mfa_step_up', 8);
      const outcome = await repo.transaction(async (db) => {
        const instant = now();
        const session = await lockCurrentSession(db, identity, instant);
        const { rows: [factor] } = await db.query(`
          SELECT encrypted_seed, last_counter, revision FROM identity_access.mfa_factors
          WHERE identity_id = $1 FOR UPDATE
        `, [session.identity_id]);
        if (!factor) return null;
        const counter = matchingCounter(unprotectSeed(key, session.identity_id, factor.encrypted_seed),
          code, instant, Number(factor.last_counter));
        if (counter === null) return null;
        await db.query('UPDATE identity_access.mfa_factors SET last_counter = $2 WHERE identity_id = $1',
          [session.identity_id, counter]);
        await db.query(`
          UPDATE identity_access.sessions
          SET mfa_verified_at = $2, mfa_session_revision = revision, mfa_factor_revision = $3 WHERE id = $1
        `, [session.id, asDate(instant), factor.revision]);
        await audit(db, session, 'identity.mfa_step_up.v1', instant);
        return { verifiedUntil: asDate(instant + STEP_UP_WINDOW) };
      });
      if (!outcome) throw invalid();
      return outcome;
    },

    async isFresh(identity) {
      if (!await canStepUp(identity)) return false;
      const instant = now();
      const { rowCount } = await repo.query(`
        SELECT 1 FROM identity_access.sessions s
        JOIN identity_access.mfa_factors f ON f.identity_id = s.identity_id
        JOIN identity_access.identities i ON i.id = s.identity_id
        WHERE s.id = $1 AND s.identity_id = $2 AND s.revision = $3
          AND s.tenant_id IS NOT DISTINCT FROM $4::uuid
          AND s.membership_id IS NOT DISTINCT FROM $5::uuid AND s.revoked_at IS NULL
          AND s.expires_at > $6 AND s.access_expires_at > $6 AND i.status = 'active'
          AND s.mfa_verified_at <= $6 AND s.mfa_verified_at > $7
          AND s.mfa_session_revision = s.revision AND s.mfa_factor_revision = f.revision
      `, [identity.sessionId, identity.identityId, identity.sessionRevision, identity.tenantId,
        identity.membershipId, asDate(instant), asDate(instant - STEP_UP_WINDOW)]);
      return rowCount === 1;
    },

    async requestRecovery(identity, { password, recoveryCode }) {
      if (typeof recoveryCode !== 'string' || !RECOVERY_CODE_PATTERN.test(recoveryCode)) throw invalid();
      const passwordHash = await verifyPrimaryPassword(identity, password, 'mfa_recovery');
      const outcome = await repo.transaction(async (db) => {
        const instant = now();
        const session = await lockCurrentSession(db, identity, instant);
        if (session.password_hash !== passwordHash) return null;
        const { rows: [factor] } = await db.query(
          'SELECT revision FROM identity_access.mfa_factors WHERE identity_id = $1 FOR UPDATE', [session.identity_id],
        );
        if (!factor) return null;
        const consumed = await db.query(`
          UPDATE identity_access.mfa_recovery_codes SET used_at = $3
          WHERE identity_id = $1 AND digest = $2 AND used_at IS NULL
        `, [session.identity_id, digest(recoveryCode), asDate(instant)]);
        if (consumed.rowCount !== 1) return null;
        const action = await startAction(db, session, 'recovery', factor.revision, instant);
        await audit(db, session, 'identity.mfa_recovery_started.v1', instant);
        return action;
      });
      if (!outcome) throw invalid();
      return outcome;
    },

    async confirmRecovery(identity, { recoveryToken, code }) {
      const ticket = decodeRecoveryTicket(recoveryToken);
      if (!ticket) throw invalid();
      needCode(code);
      const outcome = await repo.transaction(async (db) => {
        const instant = now();
        const session = await lockCurrentSession(db, identity, instant);
        const action = await readAction(db, session, ticket.id, 'recovery', ticket.hash, instant);
        if (!action) return null;
        const counter = await tryPendingFactor(db, session, action, code, instant);
        if (counter === null) return null;
        const updated = await db.query(`
          UPDATE identity_access.mfa_factors
          SET encrypted_seed = $2, last_counter = $3, revision = revision + 1
          WHERE identity_id = $1 AND revision = $4
        `, [session.identity_id, action.encrypted_seed, counter, action.expected_factor_revision]);
        if (updated.rowCount !== 1) return null;
        const recoveryCodes = await replaceRecoveryCodes(db, session.identity_id);
        await revokeAllSessions(db, session.identity_id, instant);
        await audit(db, session, 'identity.mfa_recovered.v1', instant);
        return { recoveryCodes, signInRequired: true };
      });
      if (!outcome) throw invalid();
      return outcome;
    },
  });
}

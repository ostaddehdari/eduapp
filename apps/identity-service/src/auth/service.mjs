import { randomInt, randomUUID } from 'node:crypto';
import {
  UUID, digest, equalHex, isCurrentAccessToken, isPasswordInput, issueAccessToken,
  issueRefreshToken, parseRefreshToken, privateFingerprint, verifyPassword,
} from './crypto.mjs';
import { asDate, countAttempt, createAuthRepository, revokeSession } from './repository.mjs';

const MINUTE = 60_000;
const ACCESS_TTL = 15 * MINUTE;
const SESSION_TTL = 30 * 24 * 60 * MINUTE;
const OTP_TTL = 5 * MINUTE;
const OTP_ATTEMPTS = 5;
const NO_MEMBERSHIP = Object.freeze({ tenantId: null, membershipId: null, orgUnitId: null });

export class AuthError extends Error {
  constructor(code, retryAfter) {
    super(code);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const unauthorized = () => new AuthError('AUTHENTICATION_REQUIRED');
const invalid = () => new AuthError('VALIDATION_FAILED');

function loginValue(input) {
  if (typeof input !== 'string' || input.length > 320) throw invalid();
  const normalized = input.normalize('NFKC').trim().toLowerCase();
  if (!normalized || normalized.length > 320 || /[\u0000-\u001f\u007f]/u.test(normalized)) throw invalid();
  return normalized;
}

function readSelection(input) {
  const tenantId = input.tenantId;
  const membershipId = input.membershipId;
  if ((tenantId !== undefined && (typeof tenantId !== 'string' || !UUID.test(tenantId))) ||
      (membershipId !== undefined && (typeof membershipId !== 'string' || !UUID.test(membershipId))) ||
      (membershipId !== undefined && tenantId === undefined)) throw invalid();
  return { tenantId: tenantId?.toLowerCase(), membershipId: membershipId?.toLowerCase() };
}

function validateKey(key) {
  if (!Buffer.isBuffer(key) || key.length < 32) throw new TypeError('IAM requires keys of at least 32 bytes');
  return Buffer.from(key);
}

export function createAuthService({ pool, resolveMembership, deliverOtp, accessSigningKey, otpPepper, now = Date.now }) {
  if (typeof resolveMembership !== 'function' || typeof deliverOtp !== 'function') {
    throw new TypeError('IAM requires membership and OTP delivery ports');
  }
  const accessKey = validateKey(accessSigningKey);
  const pepper = validateKey(otpPepper);
  if (accessKey.equals(pepper)) throw new TypeError('IAM keys must be distinct');
  const repo = createAuthRepository(pool);
  let pendingDeliveries = 0;

  async function confirmSelection(identityId, selected) {
    if (selected.tenantId === undefined || selected.tenantId === null) return NO_MEMBERSHIP;
    const scope = await resolveMembership({
      identityId,
      tenantId: selected.tenantId,
      membershipId: selected.membershipId ?? undefined,
    });
    if (!scope || scope.tenantId !== selected.tenantId ||
        typeof scope.membershipId !== 'string' || !UUID.test(scope.membershipId) ||
        (selected.membershipId && scope.membershipId !== selected.membershipId)) return null;
    return { tenantId: scope.tenantId, membershipId: scope.membershipId, orgUnitId: scope.orgUnitId ?? null };
  }

  async function checkLimit(action, subject, windowMs, maxAttempts) {
    const wait = await countAttempt(repo, action, privateFingerprint(pepper, action, subject),
      now(), windowMs, maxAttempts);
    if (wait !== null) throw new AuthError('RATE_LIMITED', wait);
  }

  function tokens(sessionId, deadline, instant) {
    const accessExpiry = Math.floor(Math.min(instant + ACCESS_TTL, deadline) / 1000) * 1000;
    const accessToken = issueAccessToken(accessKey, instant, accessExpiry);
    return {
      accessToken, refreshToken: issueRefreshToken(sessionId),
      accessExpiresAt: asDate(accessExpiry), refreshExpiresAt: asDate(deadline),
    };
  }

  async function openSession(db, identityId, scope) {
    const instant = now();
    const id = randomUUID();
    const bundle = tokens(id, instant + SESSION_TTL, instant);
    await db.query(`
      INSERT INTO identity_access.sessions
        (id, identity_id, refresh_hash, expires_at, access_hash, access_expires_at, tenant_id, membership_id, issued_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    `, [id, identityId, digest(bundle.refreshToken), bundle.refreshExpiresAt, digest(bundle.accessToken),
      bundle.accessExpiresAt, scope.tenantId, scope.membershipId, asDate(instant)]);
    return { sessionId: id, ...bundle, tenantId: scope.tenantId, membershipId: scope.membershipId };
  }

  return Object.freeze({
    async findActiveIdentity({ identityId }) {
      if (typeof identityId !== 'string' || !UUID.test(identityId)) return null;
      const { rows } = await repo.query(
        "SELECT id FROM identity_access.identities WHERE id = $1 AND status = 'active'", [identityId],
      );
      return rows[0] ?? null;
    },

    async login(input) {
      const login = loginValue(input.login);
      const selected = readSelection(input);
      if (!isPasswordInput(input.password)) throw invalid();
      await checkLimit('password_login', login, 15 * MINUTE, 8);
      const { rows: [identity] } = await repo.query(
        "SELECT id, password_hash FROM identity_access.identities WHERE login_normalized = $1 AND status = 'active'", [login],
      );
      if (!await verifyPassword(input.password, identity?.password_hash)) throw unauthorized();
      const scope = await confirmSelection(identity.id, selected);
      if (!scope) throw unauthorized();
      return openSession(repo, identity.id, scope);
    },

    async requestOtp(input) {
      const login = loginValue(input.login);
      const selected = readSelection(input);
      await checkLimit('otp_request', login, 15 * MINUTE, 4);
      const { rows: [identity] } = await repo.query(
        "SELECT id FROM identity_access.identities WHERE login_normalized = $1 AND status = 'active'", [login],
      );
      const challengeId = randomUUID();
      const code = String(randomInt(1_000_000)).padStart(6, '0');
      const expiresAt = asDate(now() + OTP_TTL);
      if (pendingDeliveries >= 64) throw new AuthError('SERVICE_UNAVAILABLE');
      pendingDeliveries += 1;
      try {
        await repo.query(`
          INSERT INTO identity_access.otp_challenges (id, identity_id, tenant_id, membership_id, code_hash, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [challengeId, identity?.id ?? null, selected.tenantId ?? null, selected.membershipId ?? null,
          privateFingerprint(pepper, 'otp_verify', challengeId, code), expiresAt]);
      } catch (error) {
        pendingDeliveries -= 1;
        throw error;
      }
      setImmediate(async () => {
        try {
          if (identity) await deliverOtp({ destination: login, code, expiresAt, signal: AbortSignal.timeout(10_000) });
        } catch {
          // Delivery errors must not disclose recipient presence to the requesting client.
        } finally {
          pendingDeliveries -= 1;
        }
      });
      return { challengeId, expiresAt };
    },

    async verifyOtp(input) {
      const { challengeId, code } = input;
      if (typeof challengeId !== 'string' || !UUID.test(challengeId) ||
          typeof code !== 'string' || !/^\d{6}$/.test(code)) throw invalid();
      const id = challengeId.toLowerCase();
      const outcome = await repo.transaction(async (db) => {
        const { rows: [challenge] } = await db.query(`
          SELECT c.*, i.status AS identity_status FROM identity_access.otp_challenges c
          LEFT JOIN identity_access.identities i ON i.id = c.identity_id WHERE c.id = $1 FOR UPDATE OF c
        `, [id]);
        if (!challenge || challenge.consumed_at || challenge.attempts >= OTP_ATTEMPTS ||
          challenge.expires_at.getTime() <= now()) return null;
        const matches = equalHex(challenge.code_hash, privateFingerprint(pepper, 'otp_verify', id, code));
        const verified = matches && challenge.identity_status === 'active';
        await db.query(`
          UPDATE identity_access.otp_challenges SET attempts = attempts + 1,
            consumed_at = CASE WHEN $2 THEN $3 ELSE consumed_at END WHERE id = $1
        `, [id, verified, asDate(now())]);
        if (!verified) return null;
        const scope = await confirmSelection(challenge.identity_id, {
          tenantId: challenge.tenant_id, membershipId: challenge.membership_id,
        });
        return scope ? openSession(db, challenge.identity_id, scope) : null;
      });
      if (!outcome) throw invalid();
      return outcome;
    },

    async refresh(input) {
      const { refreshToken } = input;
      const id = parseRefreshToken(refreshToken);
      if (!id) throw unauthorized();
      const selected = readSelection(input);
      const hash = digest(refreshToken);
      const outcome = await repo.transaction(async (db) => {
        const { rows: [session] } = await db.query(`
          SELECT s.*, i.status AS identity_status FROM identity_access.sessions s
          JOIN identity_access.identities i ON i.id = s.identity_id WHERE s.id = $1 FOR UPDATE OF s
        `, [id]);
        const instant = now();
        if (!session || session.revoked_at || session.identity_status !== 'active' || !session.access_hash ||
          session.expires_at.getTime() - instant < 1000) return null;
        if (!equalHex(hash, session.refresh_hash)) {
          const { rowCount } = await db.query(
            'SELECT 1 FROM identity_access.refresh_history WHERE session_id = $1 AND refresh_hash = $2', [id, hash],
          );
          if (rowCount === 1) await revokeSession(db, id, 'refresh_reuse', instant);
          return null;
        }
        const scope = await confirmSelection(session.identity_id, selected.tenantId ? selected : {
          tenantId: session.tenant_id, membershipId: session.membership_id,
        });
        const issuanceTime = now();
        if (!scope || session.expires_at.getTime() - issuanceTime < 1000) return null;
        await db.query('INSERT INTO identity_access.refresh_history (session_id, refresh_hash) VALUES ($1,$2)', [id, hash]);
        const bundle = tokens(id, session.expires_at.getTime(), issuanceTime);
        await db.query(`
          UPDATE identity_access.sessions SET refresh_hash = $2, access_hash = $3, access_expires_at = $4,
            tenant_id = $5, membership_id = $6, revision = revision + 1 WHERE id = $1
        `, [id, digest(bundle.refreshToken), digest(bundle.accessToken), bundle.accessExpiresAt,
          scope.tenantId, scope.membershipId]);
        return { sessionId: id, ...bundle, tenantId: scope.tenantId, membershipId: scope.membershipId };
      });
      if (!outcome) throw unauthorized();
      return outcome;
    },

    async authenticate(accessToken) {
      const instant = now();
      if (!isCurrentAccessToken(accessToken, accessKey, instant)) return null;
      const { rows: [session] } = await repo.query(`
        SELECT s.id, s.identity_id, s.tenant_id, s.membership_id, s.revision
        FROM identity_access.sessions s JOIN identity_access.identities i ON i.id = s.identity_id
        WHERE s.access_hash = $1 AND s.revoked_at IS NULL AND s.access_expires_at > $2
          AND s.expires_at > $2 AND i.status = 'active'
      `, [digest(accessToken), asDate(instant)]);
      if (!session) return null;
      const scope = await confirmSelection(session.identity_id, {
        tenantId: session.tenant_id, membershipId: session.membership_id,
      });
      return scope && { identityId: session.identity_id, sessionId: session.id, sessionRevision: session.revision, ...scope };
    },

    async logout({ identityId, sessionId }) {
      await repo.transaction(async (db) => {
        const { rowCount } = await db.query(
          'SELECT 1 FROM identity_access.sessions WHERE id = $1 AND identity_id = $2 FOR UPDATE', [sessionId, identityId],
        );
        if (rowCount === 1) await revokeSession(db, sessionId, 'logout', now());
      });
    },

    async listSessions({ identityId, tenantId }, { position, limit }) {
      const cursor = position ?? { issuedAt: null, id: null };
      const { rows } = await repo.query(`
        SELECT id, issued_at, expires_at FROM identity_access.sessions
        WHERE identity_id = $1 AND tenant_id IS NOT DISTINCT FROM $2::uuid
          AND revoked_at IS NULL AND expires_at > $3
          AND ($4::timestamptz IS NULL OR (issued_at, id) < ($4, $5::uuid))
        ORDER BY issued_at DESC, id DESC LIMIT $6
      `, [identityId, tenantId, asDate(now()), cursor.issuedAt, cursor.id, limit + 1]);
      const page = rows.slice(0, limit).map(({ id, issued_at, expires_at }) => ({
        id, issuedAt: issued_at.toISOString(), expiresAt: expires_at.toISOString(),
      }));
      return { data: page, nextPosition: rows.length > limit ? page.at(-1) : null };
    },
  });
}

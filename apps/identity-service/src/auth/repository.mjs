export function createAuthRepository(pool) {
  return {
    query: (...args) => pool.query(...args),
    async transaction(operation) {
      const db = await pool.connect();
      let discard = true;
      try {
        await db.query('BEGIN');
        let result;
        try {
          result = await operation(db);
        } catch (error) {
          try {
            await db.query('ROLLBACK');
            discard = false;
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], 'IAM transaction cleanup failed');
          }
          throw error;
        }
        const commit = await db.query('COMMIT');
        if (commit.command !== 'COMMIT') throw new Error('IAM transaction did not commit');
        discard = false;
        return result;
      } finally {
        db.release(discard);
      }
    },
  };
}

export const asDate = (time) => new Date(time);

export async function countAttempt(db, action, key, now, windowMs, maxAttempts) {
  const { rows: [row] } = await db.query(`
    INSERT INTO identity_access.auth_attempts AS counters
      (action, subject_hash, window_started_at, attempts) VALUES ($1, $2, $3, 1)
    ON CONFLICT (action, subject_hash) DO UPDATE
      SET window_started_at = CASE WHEN counters.window_started_at <= $4
          THEN EXCLUDED.window_started_at ELSE counters.window_started_at END,
        attempts = CASE WHEN counters.window_started_at <= $4
          THEN 1 ELSE LEAST(counters.attempts + 1, $5::integer + 1) END
    RETURNING attempts, window_started_at
  `, [action, key, asDate(now), asDate(now - windowMs), maxAttempts]);
  return row.attempts > maxAttempts
    ? Math.max(1, Math.ceil((row.window_started_at.getTime() + windowMs - now) / 1000))
    : null;
}

export async function revokeSession(db, sessionId, reason, now) {
  await db.query(`
    WITH updated AS (
      UPDATE identity_access.sessions
      SET revoked_at = $2, revision = revision + 1, access_hash = NULL, access_expires_at = NULL
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING id, revision
    )
    INSERT INTO identity_access.session_revocations (session_id, revision, reason, occurred_at)
    SELECT id, revision, $3, $2 FROM updated
  `, [sessionId, asDate(now), reason]);
}

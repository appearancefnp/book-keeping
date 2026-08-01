import { randomBytes } from 'node:crypto';
import { appPool } from '../db/pool.js';
import { verifyPassword } from './passwords.js';
import { verifyTotpStep } from './totp.js';

const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

export async function login(email: string, password: string, totpCode: string, atUnixSeconds: number): Promise<{ sessionToken: string }> {
  // The whole flow runs in one transaction with the user row locked so the
  // single-use TOTP check-and-update is atomic: two concurrent replays of the
  // same code cannot both pass, because the first advances last_totp_step.
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    const ures = await client.query(
      `SELECT id, status, password_hash AS "passwordHash", totp_secret AS "totpSecret", last_totp_step AS "lastTotpStep"
       FROM users WHERE email = $1 FOR UPDATE`,
      [email],
    );
    const user = ures.rows[0];
    if (!user || user.status !== 'active' || !verifyPassword(password, user.passwordHash)) throw new Error('Invalid credentials');

    const step = verifyTotpStep(user.totpSecret, totpCode, atUnixSeconds);
    // Reject an invalid code OR one whose step was already consumed. The second
    // check is what makes TOTP genuinely single-use: an intercepted code cannot
    // be replayed within its ±1 window once the first use records its step.
    if (step === null || (user.lastTotpStep !== null && step <= Number(user.lastTotpStep))) {
      throw new Error('Invalid 2FA code');
    }
    await client.query('UPDATE users SET last_totp_step = $1 WHERE id = $2', [step, user.id]);

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date((atUnixSeconds + SESSION_TTL_SECONDS) * 1000).toISOString();
    // Opportunistic sweep of expired rows (12h TTL, no cron by design). Best-effort
    // under a savepoint so a sweep failure never aborts the login transaction, and
    // on the injected clock so tests with fixed time behave like production.
    try {
      await client.query('SAVEPOINT sweep');
      await client.query('DELETE FROM sessions WHERE expires_at < to_timestamp($1)', [atUnixSeconds]);
      await client.query('RELEASE SAVEPOINT sweep');
    } catch {
      try { await client.query('ROLLBACK TO SAVEPOINT sweep'); } catch { /* ignore */ }
    }
    await client.query('INSERT INTO sessions(token, user_id, expires_at) VALUES ($1,$2,$3)', [token, user.id, expiresAt]);
    await client.query('COMMIT');
    return { sessionToken: token };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function validateSession(token: string, atUnixSeconds: number): Promise<{ userId: string; firmId: string; role: string } | null> {
  const res = await appPool.query(
    `SELECT s.user_id AS "userId", u.firm_id AS "firmId", u.role,
            EXTRACT(EPOCH FROM s.expires_at) AS "expiresEpoch"
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = $1`,
    [token],
  );
  const row = res.rows[0];
  if (!row) return null;
  if (Number(row.expiresEpoch) <= atUnixSeconds) return null;
  return { userId: row.userId, firmId: row.firmId, role: row.role };
}

export async function logout(token: string): Promise<void> {
  await appPool.query('DELETE FROM sessions WHERE token = $1', [token]);
}

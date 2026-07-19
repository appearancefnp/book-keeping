import { randomBytes } from 'node:crypto';
import { appPool } from '../db/pool.js';
import { findUserByEmail } from './users.js';
import { verifyPassword } from './passwords.js';
import { verifyTotp } from './totp.js';

const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12h

export async function login(email: string, password: string, totpCode: string, atUnixSeconds: number): Promise<{ sessionToken: string }> {
  const user = await findUserByEmail(email);
  if (!user || user.status !== 'active' || !verifyPassword(password, user.passwordHash)) throw new Error('Invalid credentials');
  if (!verifyTotp(user.totpSecret, totpCode, atUnixSeconds)) throw new Error('Invalid 2FA code');

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date((atUnixSeconds + SESSION_TTL_SECONDS) * 1000).toISOString();
  // Opportunistic sweep: expired rows accumulate otherwise (12h TTL, no cron by
  // design). Best-effort — a sweep failure must not block a valid login — and on
  // the injected clock so tests with fixed time behave like production.
  try {
    await appPool.query('DELETE FROM sessions WHERE expires_at < to_timestamp($1)', [atUnixSeconds]);
  } catch { /* best-effort */ }
  await appPool.query('INSERT INTO sessions(token, user_id, expires_at) VALUES ($1,$2,$3)', [token, user.id, expiresAt]);
  return { sessionToken: token };
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

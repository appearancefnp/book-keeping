import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { appPool } from '../db/pool.js';
import { hashPassword } from './passwords.js';
import { generateTotpSecret, totpUri, verifyTotp } from './totp.js';

const INVITE_TTL_SECONDS = 72 * 3600;

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Creates a one-time invite for `userId`, rotating their TOTP secret and
 * locking the account (`status='invited'`) until the invite is accepted.
 * Prior unused invites for the user are invalidated. Returns the RAW token
 * (only its sha256 is stored) — show it once, never log it.
 */
export async function createInvite(
  userId: string, createdBy: string, atUnixSeconds: number,
): Promise<{ token: string; expiresAtIso: string }> {
  const token = randomBytes(32).toString('hex');
  const expiresAtIso = new Date((atUnixSeconds + INVITE_TTL_SECONDS) * 1000).toISOString();
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM user_invites WHERE user_id = $1 AND used_at IS NULL`, [userId]);
    // Re-invite is the credential-reset path — live sessions must not survive it.
    await client.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await client.query(
      `UPDATE users SET status = 'invited', totp_secret = $2 WHERE id = $1`,
      [userId, generateTotpSecret()],
    );
    await client.query(
      `INSERT INTO user_invites(user_id, token_hash, expires_at, created_by) VALUES ($1,$2,$3,$4)`,
      [userId, sha256(token), expiresAtIso, createdBy],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { token, expiresAtIso };
}

interface InviteRow { inviteId: string; userId: string; email: string; firmName: string; totpSecret: string; }

async function findValidInvite(token: string, atUnixSeconds: number): Promise<InviteRow | null> {
  const res = await appPool.query(
    `SELECT i.id AS "inviteId", u.id AS "userId", u.email, f.name AS "firmName", u.totp_secret AS "totpSecret"
     FROM user_invites i
     JOIN users u ON u.id = i.user_id
     JOIN firms f ON f.id = u.firm_id
     WHERE i.token_hash = $1 AND i.used_at IS NULL
       AND EXTRACT(EPOCH FROM i.expires_at) > $2`,
    [sha256(token), atUnixSeconds],
  );
  return res.rows[0] ?? null;
}

/** Returns invite details for the enrolment page, or null (invalid = expired = used, indistinguishable). */
export async function previewInvite(
  token: string, atUnixSeconds: number,
): Promise<{ email: string; firmName: string; otpauthUri: string; totpSecret: string } | null> {
  const row = await findValidInvite(token, atUnixSeconds);
  if (!row) return null;
  return {
    email: row.email,
    firmName: row.firmName,
    totpSecret: row.totpSecret,
    otpauthUri: totpUri(row.totpSecret, row.email),
  };
}

const acceptSchema = z.object({ password: z.string().min(12), totpCode: z.string().length(6) });

/**
 * Activates the account: verifies the TOTP code against the invite's fresh
 * secret (proves the authenticator is enrolled) BEFORE setting the password
 * and flipping status. Single transaction; generic error on any failure.
 */
export async function acceptInvite(
  token: string, input: { password: string; totpCode: string }, atUnixSeconds: number,
): Promise<void> {
  const p = acceptSchema.parse(input);
  const row = await findValidInvite(token, atUnixSeconds);
  if (!row || !verifyTotp(row.totpSecret, p.totpCode, atUnixSeconds)) {
    throw new Error('invalid invite');
  }
  const client = await appPool.connect();
  try {
    await client.query('BEGIN');
    const used = await client.query(
      `UPDATE user_invites SET used_at = now() WHERE id = $1 AND used_at IS NULL`,
      [row.inviteId],
    );
    if (!used.rowCount) throw new Error('invalid invite'); // raced double-accept
    await client.query(
      `UPDATE users SET password_hash = $2, status = 'active' WHERE id = $1`,
      [row.userId, hashPassword(p.password)],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

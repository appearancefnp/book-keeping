import { appPool } from '../db/pool.js';

const WINDOW_SECONDS = 15 * 60;
const MAX_FAILURES = 5;

/** True unless ANY identifier has >= MAX_FAILURES failures inside the current window. */
export async function checkLoginAllowed(identifiers: string[], atUnixSeconds: number): Promise<boolean> {
  if (identifiers.length === 0) return true;
  const res = await appPool.query(
    `SELECT 1 FROM login_attempts
     WHERE identifier = ANY($1)
       AND fail_count >= $2
       AND EXTRACT(EPOCH FROM window_start) > $3::bigint - $4::bigint
     LIMIT 1`,
    [identifiers, MAX_FAILURES, atUnixSeconds, WINDOW_SECONDS],
  );
  return res.rowCount === 0;
}

/** Records one failure per identifier; a failure outside the window starts a fresh window. */
export async function recordLoginFailure(identifiers: string[], atUnixSeconds: number): Promise<void> {
  const nowIso = new Date(atUnixSeconds * 1000).toISOString();
  for (const id of identifiers) {
    await appPool.query(
      `INSERT INTO login_attempts(identifier, window_start, fail_count) VALUES ($1, $2, 1)
       ON CONFLICT (identifier) DO UPDATE SET
         fail_count = CASE WHEN EXTRACT(EPOCH FROM login_attempts.window_start) > $3::bigint - $4::bigint
                           THEN login_attempts.fail_count + 1 ELSE 1 END,
         window_start = CASE WHEN EXTRACT(EPOCH FROM login_attempts.window_start) > $3::bigint - $4::bigint
                             THEN login_attempts.window_start ELSE $2 END`,
      [id, nowIso, atUnixSeconds, WINDOW_SECONDS],
    );
  }
  // Opportunistic prune: identifiers that never succeed would otherwise grow the
  // table unbounded (attacker-chosen values). 24h keeps a short forensic window;
  // the limiter itself only reads the last WINDOW_SECONDS.
  await appPool.query(
    `DELETE FROM login_attempts WHERE EXTRACT(EPOCH FROM window_start) < $1::bigint - 86400`,
    [atUnixSeconds],
  );
}

export async function clearLoginFailures(identifiers: string[]): Promise<void> {
  if (identifiers.length === 0) return;
  await appPool.query(`DELETE FROM login_attempts WHERE identifier = ANY($1)`, [identifiers]);
}

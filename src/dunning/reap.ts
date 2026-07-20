import type { PoolClient } from 'pg';

/**
 * Chain reaper for dunning (runs on a withSupervisor tx). Seeds today's dunning_run for every
 * enabled policy client that has no live (pending/running) dunning_run job — recovering
 * never-seeded and terminal-failed chains. Idempotent: the dunning:<today> dedup key makes a
 * re-run a no-op, and if today's job already exists (even failed) the insert is skipped, so the
 * chain self-heals on the next date rollover (<=1-day window, acceptable for informational dunning).
 */
export async function reapDunning(tx: PoolClient, args: { now: Date }): Promise<{ seeded: number }> {
  const today = args.now.toISOString().slice(0, 10);
  // NOTE: this seeds only clients with an EXPLICIT dunning_policy row where enabled = true — the
  // same scope as backfill 035 and the policy-enable re-seed. getDunningPolicy() defaults a
  // missing row to enabled:true, but that default serves the manual "run now" path only; automated
  // dunning (this reaper + the daily chain) requires an explicit enabled row, which the enable flow
  // writes. A client that never configures dunning therefore has no automated chain and is not
  // revived here — by design.
  const res = await tx.query(
    `INSERT INTO jobs (client_company_id, firm_id, type, run_at, payload, dedup_key)
     SELECT c.id, c.firm_id, 'dunning_run', $1::timestamptz,
            jsonb_build_object('asOf', $2::text), 'dunning:' || $2::text
       FROM client_companies c
       JOIN dunning_policy p ON p.client_company_id = c.id
      WHERE p.enabled = true
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.client_company_id = c.id AND j.type = 'dunning_run'
             AND j.status IN ('pending','running'))
     ON CONFLICT (client_company_id, type, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [args.now.toISOString(), today],
  );
  return { seeded: res.rowCount ?? 0 };
}

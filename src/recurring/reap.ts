import type { PoolClient } from 'pg';

/**
 * Chain reaper for recurring invoices (runs on a withSupervisor tx). Seeds a recurring_generate for
 * every ACTIVE template that is due (next_run_date <= today) and has no live (pending/running)
 * recurring_generate job — recovering never-seeded, terminal-failed, and re-activated chains.
 * Idempotent via the recurring:<templateId>:<period> dedup key + the NOT EXISTS(live job) guard.
 *
 * NOTE: unlike dunning (whose dedup key is date-based and so rolls over daily), the recurring dedup
 * key is period-based and stays IDENTICAL across repeated reap sweeps until generateDueRecurring
 * actually advances the template's next_run_date. So a terminal-failed job for the current period
 * would collide with a plain ON CONFLICT DO NOTHING and never be revived. Since the NOT EXISTS guard
 * above already guarantees we only reach the conflict when the existing row for that dedup key is
 * NOT live (pending/running), it's always safe to resurrect it here.
 */
export async function reapRecurring(tx: PoolClient, args: { now: Date }): Promise<{ seeded: number }> {
  const today = args.now.toISOString().slice(0, 10);
  const res = await tx.query(
    `INSERT INTO jobs (client_company_id, firm_id, type, run_at, payload, dedup_key)
     SELECT t.client_company_id, c.firm_id, 'recurring_generate', $1::timestamptz,
            jsonb_build_object('templateId', t.id::text, 'period', to_char(t.next_run_date, 'YYYY-MM')),
            'recurring:' || t.id::text || ':' || to_char(t.next_run_date, 'YYYY-MM')
       FROM recurring_invoice_templates t
       JOIN client_companies c ON c.id = t.client_company_id
      WHERE t.active = true
        AND t.next_run_date <= $2::date
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.client_company_id = t.client_company_id AND j.type = 'recurring_generate'
             AND j.payload->>'templateId' = t.id::text
             AND j.status IN ('pending','running'))
     ON CONFLICT (client_company_id, type, dedup_key) WHERE dedup_key IS NOT NULL
     DO UPDATE SET status = 'pending', run_at = EXCLUDED.run_at, payload = EXCLUDED.payload,
                   attempts = 0, last_error = NULL, claimed_at = NULL, updated_at = now()
     RETURNING id`,
    [args.now.toISOString(), today],
  );
  return { seeded: res.rowCount ?? 0 };
}

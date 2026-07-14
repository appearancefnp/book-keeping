import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { createTask } from '../collab/tasks.js';
import { getDunningPolicy, listStages } from './policy.js';
import { accruedLateFeeCents } from './late-fee.js';

interface OverdueRow {
  einvoiceId: string; invoiceNumber: string; outstandingCents: string; dueDate: string;
}

/** Whole days between two YYYY-MM-DD dates (asOf − due), floored. */
function daysBetween(dueDate: string, asOf: string): number {
  const d = Date.parse(dueDate + 'T00:00:00Z');
  const a = Date.parse(asOf + 'T00:00:00Z');
  return Math.floor((a - d) / 86_400_000);
}

function centsToMajor(cents: string): string {
  const n = BigInt(cents);
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

export async function runDunning(
  tx: PoolClient, ctx: TenantContext, opts: { asOf: string },
): Promise<{ prompted: number; byLevel: Record<number, number> }> {
  const byLevel: Record<number, number> = {};
  const policy = await getDunningPolicy(tx, ctx);
  if (!policy.enabled) return { prompted: 0, byLevel };

  const stages = await listStages(tx, ctx); // ascending by level
  const overdue = await tx.query<OverdueRow>(
    `SELECT id AS "einvoiceId", invoice_number AS "invoiceNumber",
            (grand_total_cents - amount_paid_cents)::text AS "outstandingCents",
            to_char(due_date, 'YYYY-MM-DD') AS "dueDate"
       FROM einvoices
      WHERE client_company_id = $1 AND direction = 'outbound'
        AND status IN ('open','partially_paid')
        AND due_date IS NOT NULL AND due_date < $2::date`,
    [ctx.clientCompanyId, opts.asOf],
  );

  let prompted = 0;
  for (const row of overdue.rows) {
    const daysOverdue = daysBetween(row.dueDate, opts.asOf);
    // highest stage whose threshold is reached
    let reached: { level: number; daysOverdue: number } | null = null;
    for (const s of stages) if (daysOverdue >= s.daysOverdue) reached = s;
    if (!reached) continue;

    const fee = accruedLateFeeCents({
      outstandingCents: row.outstandingCents, daysOverdue,
      annualBps: policy.lateFeeAnnualBps, flatCents: policy.lateFeeFlatCents,
    });
    // Event-first: the unique (client, einvoice, level) constraint claims this level atomically,
    // so an overlapping/at-least-once redelivered run can't duplicate the task or abort mid-run.
    const claimed = await tx.query(
      `INSERT INTO dunning_events(client_company_id, einvoice_id, level, accrued_fee_cents)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (client_company_id, einvoice_id, level) DO NOTHING
       RETURNING id`,
      [ctx.clientCompanyId, row.einvoiceId, reached.level, fee],
    );
    if (!claimed.rowCount) continue; // already handled at this level
    const eventId = claimed.rows[0].id as string;

    const title = `Chase invoice ${row.invoiceNumber} — ${daysOverdue} days overdue (level ${reached.level})`;
    const detail = `Outstanding ${centsToMajor(row.outstandingCents)}. Accrued late fee ${centsToMajor(fee)}.`;
    const { id: taskId } = await createTask(tx, ctx, { title, detail });
    await tx.query(`UPDATE dunning_events SET task_id = $1 WHERE id = $2`, [taskId, eventId]);
    prompted += 1;
    byLevel[reached.level] = (byLevel[reached.level] ?? 0) + 1;
  }
  return { prompted, byLevel };
}

import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { enqueue } from '../jobs/queue.js';

/** YYYY-MM-DD for (year, month 1-12), with anchorDay clamped to the month's last day (UTC). */
export function clampToMonth(year: number, month: number, anchorDay: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month = last day of this
  const day = Math.min(anchorDay, lastDay);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The next occurrence after isoDate: add intervalMonths, take the day from anchorDay (clamped). */
export function advanceRunDate(isoDate: string, intervalMonths: number, anchorDay: number): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  const total = d.getUTCMonth() + intervalMonths; // getUTCMonth is 0-11
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month = (total % 12) + 1; // back to 1-12
  return clampToMonth(year, month, anchorDay);
}

/** The YYYY-MM period key of a run date (unique per occurrence for interval >= 1 month). */
export function periodKey(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Deterministic per-occurrence invoice number: PREFIX-YYYY-MM-<first 8 of templateId>. */
export function buildRecurringInvoiceNumber(prefix: string | null, isoDate: string, templateId: string): string {
  return `${prefix ?? 'INV'}-${periodKey(isoDate)}-${templateId.slice(0, 8)}`;
}

/**
 * Enqueue a recurring_generate for a template's period, deduped on recurring:<templateId>:<period>.
 * Optional asOf (YYYY-MM-DD) is threaded into the payload for deterministic tests; in production it
 * is omitted and the handler bills against the real current date.
 */
export async function enqueueRecurringGenerate(
  tx: PoolClient, ctx: TenantContext,
  args: { templateId: string; period: string; runAt: Date; asOf?: string },
): Promise<{ jobId: string } | { deduped: true }> {
  return enqueue(tx, ctx, {
    type: 'recurring_generate',
    runAt: args.runAt,
    payload: { templateId: args.templateId, period: args.period, ...(args.asOf ? { asOf: args.asOf } : {}) },
    dedupKey: `recurring:${args.templateId}:${args.period}`,
  });
}

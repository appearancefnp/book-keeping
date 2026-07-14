import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { enqueue } from '../jobs/queue.js';

/** UTC midnight of a YYYY-MM-DD date. */
export function utcMidnight(isoDate: string): Date {
  return new Date(isoDate + 'T00:00:00Z');
}

/** The next calendar day of a YYYY-MM-DD date, as YYYY-MM-DD (UTC). */
export function nextDay(isoDate: string): string {
  const d = utcMidnight(isoDate);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Enqueue a dunning_run for asOf at UTC midnight, deduped on the date. */
export async function enqueueDunningRun(
  tx: PoolClient, ctx: TenantContext, args: { asOf: string },
): Promise<{ jobId: string } | { deduped: true }> {
  return enqueue(tx, ctx, {
    type: 'dunning_run',
    runAt: utcMidnight(args.asOf),
    payload: { asOf: args.asOf },
    dedupKey: `dunning:${args.asOf}`,
  });
}

import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { fromCents } from '../db/money.js';

export interface ArAging {
  asOf: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90plus: string; total: string;
}

/** Aged receivables: outstanding on open/partially-paid outbound invoices, bucketed by
 *  (asOf - due_date). Falls back to issue_date when due_date is null. */
export async function arAging(
  tx: PoolClient, ctx: TenantContext, opts: { asOf: string },
): Promise<ArAging> {
  const res = await tx.query(
    `SELECT ($2::date - COALESCE(due_date, issue_date)) AS days,
            (grand_total_cents - amount_paid_cents) AS outstanding
     FROM einvoices
     WHERE client_company_id = $1 AND direction = 'outbound'
       AND status IN ('open','partially_paid')
       AND (grand_total_cents - amount_paid_cents) > 0`,
    [ctx.clientCompanyId, opts.asOf],
  );

  let current = 0n, d1_30 = 0n, d31_60 = 0n, d61_90 = 0n, d90plus = 0n;
  for (const r of res.rows) {
    const days = Number(r.days);
    const amt = BigInt(r.outstanding);
    if (days <= 0) current += amt;
    else if (days <= 30) d1_30 += amt;
    else if (days <= 60) d31_60 += amt;
    else if (days <= 90) d61_90 += amt;
    else d90plus += amt;
  }
  const total = current + d1_30 + d31_60 + d61_90 + d90plus;
  return {
    asOf: opts.asOf,
    current: fromCents(current), d1_30: fromCents(d1_30), d31_60: fromCents(d31_60),
    d61_90: fromCents(d61_90), d90plus: fromCents(d90plus), total: fromCents(total),
  };
}

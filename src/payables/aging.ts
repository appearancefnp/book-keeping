import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { fromCents } from '../db/money.js';

export interface ApAging {
  asOf: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90plus: string; total: string;
}

/** Aged payables: outstanding on open/partially-paid bills, bucketed by (asOf - due_date). */
export async function apAging(
  tx: PoolClient, ctx: TenantContext, opts: { asOf: string },
): Promise<ApAging> {
  const res = await tx.query(
    `SELECT ($2::date - due_date) AS days, (grand_total_cents - amount_paid_cents) AS outstanding
     FROM bills
     WHERE client_company_id = $1 AND status IN ('open','partially_paid')
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
  // Applied vendor credit notes net down the payable, aged by their own issue
  // date the same way bills age by due date (asOf - date; positive = older).
  const creditRes = await tx.query(
    `SELECT ($2::date - issue_date) AS days, grand_total_cents AS amount
     FROM vendor_credit_notes
     WHERE client_company_id = $1 AND status = 'applied' AND grand_total_cents > 0`,
    [ctx.clientCompanyId, opts.asOf],
  );
  for (const r of creditRes.rows) {
    const days = Number(r.days);
    const amt = BigInt(r.amount);
    if (days <= 0) current -= amt;
    else if (days <= 30) d1_30 -= amt;
    else if (days <= 60) d31_60 -= amt;
    else if (days <= 90) d61_90 -= amt;
    else d90plus -= amt;
  }
  const total = current + d1_30 + d31_60 + d61_90 + d90plus;
  return {
    asOf: opts.asOf,
    current: fromCents(current), d1_30: fromCents(d1_30), d31_60: fromCents(d31_60),
    d61_90: fromCents(d61_90), d90plus: fromCents(d90plus), total: fromCents(total),
  };
}

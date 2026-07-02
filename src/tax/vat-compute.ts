import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface VatConfig { outputVatAccount: string; inputVatAccount: string; }
export interface VatContribution { accountCode: string; side: 'output' | 'input'; entryId: string; amountCents: string; }
export interface VatComputation {
  fromDate: string; toDate: string;
  outputVatCents: string; inputVatCents: string; netPayableCents: string;
  contributions: VatContribution[];
}

export async function computeVat(
  tx: PoolClient, ctx: TenantContext,
  args: { fromDate: string; toDate: string; config: VatConfig },
): Promise<VatComputation> {
  // Output VAT = credits on the output account; input VAT = debits on the input account, within the date range.
  const res = await tx.query(
    `SELECT a.code AS "accountCode", je.id AS "entryId",
            (ROUND(jl.debit * 100))::bigint AS debit_cents,
            (ROUND(jl.credit * 100))::bigint AS credit_cents
     FROM journal_lines jl
     JOIN journal_entries je ON je.id = jl.entry_id
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.client_company_id = $1
       AND je.entry_date BETWEEN $2 AND $3
       AND a.code IN ($4, $5)
     ORDER BY je.entry_date, je.id`,
    [ctx.clientCompanyId, args.fromDate, args.toDate, args.config.outputVatAccount, args.config.inputVatAccount],
  );

  let output = 0n; let input = 0n;
  const contributions: VatContribution[] = [];
  for (const row of res.rows) {
    if (row.accountCode === args.config.outputVatAccount) {
      const cents = BigInt(row.credit_cents);
      if (cents !== 0n) { output += cents; contributions.push({ accountCode: row.accountCode, side: 'output', entryId: row.entryId, amountCents: cents.toString() }); }
    } else {
      const cents = BigInt(row.debit_cents);
      if (cents !== 0n) { input += cents; contributions.push({ accountCode: row.accountCode, side: 'input', entryId: row.entryId, amountCents: cents.toString() }); }
    }
  }

  return {
    fromDate: args.fromDate, toDate: args.toDate,
    outputVatCents: output.toString(), inputVatCents: input.toString(), netPayableCents: (output - input).toString(),
    contributions,
  };
}

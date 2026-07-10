import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { accountBalances, type DatedBalanceRow } from '../ledger/balances.js';
import type { StatementLine, StatementSection } from './profit-and-loss.js';
import { toCents, fromCents } from '../db/money.js';

export interface BalanceSheet {
  asOf: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  currentPeriodResult: string;
  totalAssets: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;
}

const RESULT_LINE_NAME = 'Current-period result';

/** Build a section, flipping to the natural presentation sign. Zero lines omitted. */
function section(rows: DatedBalanceRow[], normal: 'credit' | 'debit'): { lines: StatementLine[]; subtotal: bigint } {
  const lines: StatementLine[] = [];
  let subtotal = 0n;
  for (const r of rows) {
    const debitNormal = toCents(r.balance);
    const amount = normal === 'credit' ? -debitNormal : debitNormal;
    if (amount === 0n) continue;
    lines.push({ code: r.code, name: r.name, amount: fromCents(amount) });
    subtotal += amount;
  }
  return { lines, subtotal };
}

export async function balanceSheet(
  tx: PoolClient,
  ctx: TenantContext,
  opts: { asOf: string },
): Promise<BalanceSheet> {
  const rows = await accountBalances(tx, ctx, { to: opts.asOf });

  const assets = section(rows.filter((r) => r.type === 'asset'), 'debit');
  const liabilities = section(rows.filter((r) => r.type === 'liability'), 'credit');
  const equityBase = section(rows.filter((r) => r.type === 'equity'), 'credit');

  // Current-period result folded into equity (no period-closing yet):
  // Σincome (credit-normal) − Σexpense (debit-normal), both to asOf.
  let result = 0n;
  for (const r of rows) {
    if (r.type === 'income') result += -toCents(r.balance); // credit-normal
    else if (r.type === 'expense') result -= toCents(r.balance); // debit-normal
  }

  const equityLines = [...equityBase.lines];
  if (result !== 0n) equityLines.push({ code: '', name: RESULT_LINE_NAME, amount: fromCents(result) });
  const equitySubtotal = equityBase.subtotal + result;

  const totalAssets = assets.subtotal;
  const totalLiabEquity = liabilities.subtotal + equitySubtotal;

  return {
    asOf: opts.asOf,
    assets: { lines: assets.lines, subtotal: fromCents(assets.subtotal) },
    liabilities: { lines: liabilities.lines, subtotal: fromCents(liabilities.subtotal) },
    equity: { lines: equityLines, subtotal: fromCents(equitySubtotal) },
    currentPeriodResult: fromCents(result),
    totalAssets: fromCents(totalAssets),
    totalLiabilitiesAndEquity: fromCents(totalLiabEquity),
    balanced: totalAssets === totalLiabEquity,
  };
}

import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { accountBalances, type DatedBalanceRow } from '../ledger/balances.js';
import { toCents, fromCents } from '../db/money.js';

export interface StatementLine { code: string; name: string; amount: string; }
export interface StatementSection { lines: StatementLine[]; subtotal: string; }
export interface ProfitAndLoss {
  from: string | null;
  to: string | null;
  income: StatementSection;
  expense: StatementSection;
  netProfit: string;
}

/** Build a section from rows of one type. `sign` flips debit-normal balance to
 *  the natural presentation sign (credit-normal for income, debit-normal for
 *  expense). Zero-amount lines are omitted. */
function section(rows: DatedBalanceRow[], normal: 'credit' | 'debit'): StatementSection {
  const lines: StatementLine[] = [];
  let subtotal = 0n;
  for (const r of rows) {
    // r.balance is debit-normal (debit - credit).
    const debitNormal = toCents(r.balance);
    const amount = normal === 'credit' ? -debitNormal : debitNormal;
    if (amount === 0n) continue;
    lines.push({ code: r.code, name: r.name, amount: fromCents(amount) });
    subtotal += amount;
  }
  return { lines, subtotal: fromCents(subtotal) };
}

export async function profitAndLoss(
  tx: PoolClient,
  ctx: TenantContext,
  range: { from?: string; to?: string },
): Promise<ProfitAndLoss> {
  const rows = await accountBalances(tx, ctx, range);
  const income = section(rows.filter((r) => r.type === 'income'), 'credit');
  const expense = section(rows.filter((r) => r.type === 'expense'), 'debit');
  const netProfit = fromCents(toCents(income.subtotal) - toCents(expense.subtotal));
  return { from: range.from ?? null, to: range.to ?? null, income, expense, netProfit };
}

import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { accountBalances, type DatedBalanceRow } from '../ledger/balances.js';
import { toCents, fromCents } from '../db/money.js';

export interface EquityAccountLine {
  code: string; name: string;
  opening: string; movement: string; closing: string; // credit-normal
}
export interface StatementOfEquity {
  from: string;
  to: string;
  accounts: EquityAccountLine[];
  /** Accumulated (un-closed) profit/loss carried in equity; `movement` == P&L for the period. */
  result: { opening: string; movement: string; closing: string };
  openingTotal: string;
  movementTotal: string;
  closingTotal: string;
  /** openingTotal + movementTotal === closingTotal (invariant cross-check). */
  balanced: boolean;
}

/** UTC-safe YYYY-MM-DD minus one day. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Accumulated result (credit-normal net profit) carried in the income/expense accounts. */
function resultCents(rows: DatedBalanceRow[]): bigint {
  let c = 0n;
  for (const r of rows) {
    if (r.type === 'income') c += -toCents(r.balance); // credit-normal
    else if (r.type === 'expense') c -= toCents(r.balance); // debit-normal
  }
  return c;
}

export async function statementOfEquity(
  tx: PoolClient,
  ctx: TenantContext,
  range: { from: string; to: string },
): Promise<StatementOfEquity> {
  const opening = await accountBalances(tx, ctx, { to: dayBefore(range.from) });
  const closing = await accountBalances(tx, ctx, { to: range.to });
  const movement = await accountBalances(tx, ctx, range); // independent period movement
  const openingByCode = new Map(opening.map((r) => [r.code, r]));
  const movementByCode = new Map(movement.map((r) => [r.code, r]));

  const accounts: EquityAccountLine[] = [];
  let openingTotal = 0n, closingTotal = 0n, movementTotal = 0n;
  for (const r of closing) {
    if (r.type !== 'equity') continue;
    const openCents = -toCents(openingByCode.get(r.code)?.balance ?? '0'); // credit-normal
    const closeCents = -toCents(r.balance);
    const moveCents = -toCents(movementByCode.get(r.code)?.balance ?? '0'); // from the period query
    openingTotal += openCents;
    closingTotal += closeCents;
    movementTotal += moveCents;
    if (openCents === 0n && closeCents === 0n && moveCents === 0n) continue;
    accounts.push({
      code: r.code, name: r.name,
      opening: fromCents(openCents), movement: fromCents(moveCents), closing: fromCents(closeCents),
    });
  }

  const resultOpen = resultCents(opening);
  const resultClose = resultCents(closing);
  const resultMove = resultCents(movement); // period P&L, independent of the open/close cutoffs
  openingTotal += resultOpen;
  closingTotal += resultClose;
  movementTotal += resultMove;

  return {
    from: range.from,
    to: range.to,
    accounts,
    result: { opening: fromCents(resultOpen), movement: fromCents(resultMove), closing: fromCents(resultClose) },
    openingTotal: fromCents(openingTotal),
    movementTotal: fromCents(movementTotal),
    closingTotal: fromCents(closingTotal),
    // Genuine cross-check: period movements (separate query) must bridge the
    // opening and closing cumulative balances. A date-boundary bug breaks it.
    balanced: openingTotal + movementTotal === closingTotal,
  };
}

import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { accountBalances, type DatedBalanceRow } from '../ledger/balances.js';
import { toCents, fromCents } from '../db/money.js';

export interface CashFlowLine { code: string; name: string; amount: string; }
export interface CashFlowStatement {
  from: string;
  to: string;
  /** Indirect-method starting line: net profit/loss for the period (credit-normal, == P&L). */
  netProfit: string;
  /** Operating working-capital movements (real balance-sheet accounts). */
  workingCapital: CashFlowLine[];
  operatingSubtotal: string;
  investing: CashFlowLine[];
  investingSubtotal: string;
  financing: CashFlowLine[];
  financingSubtotal: string;
  /** operating + investing + financing. */
  netChange: string;
  openingCash: string;
  closingCash: string;
  /** openingCash + netChange === closingCash (invariant cross-check). */
  reconciles: boolean;
}

type Activity = 'cash' | 'operating' | 'investing' | 'financing';

/**
 * Activity classification cannot come from `accounts.type` alone (all cash is
 * `asset`; type has no operating/investing/financing axis), so cash and the
 * long-term buckets are keyed off configurable account-code prefixes defaulting
 * to the Latvian unified chart of accounts. This deliberately extends the
 * existing hard-coded account-mapping debt (see `src/bankfeed/sync.ts`,
 * `HANDOFF.md` §M2 follow-ups) rather than resolving it — a per-client
 * account-mapping settings screen is still owed. Env-overridable:
 *   CASHFLOW_CASH_CODES       default '26'        (naudas līdzekļi: kase, banka, ceļā)
 *   CASHFLOW_INVESTING_CODES  default '11,12,13'  (ilgtermiņa ieguldījumi)
 *   CASHFLOW_FINANCING_CODES  default '51,52'     (aizņēmumi / borrowings)
 * Equity accounts are always financing (by type — robust, no prefix needed).
 *
 * The Operating+Investing+Financing total equals the change in cash by
 * construction (every journal entry is balanced, so debit-normal movements over
 * any period sum to zero), so the statement always ties to the balance sheet
 * regardless of the mapping — only the split between the three buckets depends
 * on it. `reconciles` re-checks this against an independent opening-cash query.
 */
function prefixes(env: string | undefined, fallback: string): string[] {
  return (env ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
}

export function classifyActivity(
  row: Pick<DatedBalanceRow, 'code' | 'type'>,
  cfg: { cash: string[]; investing: string[]; financing: string[] },
): Activity {
  const code = row.code;
  // Cash is always an asset — gate on type so a non-asset account whose code
  // happens to match a cash prefix (env override / non-standard chart) can't be
  // mis-bucketed out of net profit / financing.
  if (row.type === 'asset' && cfg.cash.some((p) => code.startsWith(p))) return 'cash';
  if (row.type === 'equity') return 'financing';
  if (row.type === 'asset' && cfg.investing.some((p) => code.startsWith(p))) return 'investing';
  if (row.type === 'liability' && cfg.financing.some((p) => code.startsWith(p))) return 'financing';
  return 'operating';
}

/** UTC-safe YYYY-MM-DD minus one day. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function cashFlow(
  tx: PoolClient,
  ctx: TenantContext,
  range: { from: string; to: string },
): Promise<CashFlowStatement> {
  const cfg = {
    cash: prefixes(process.env.CASHFLOW_CASH_CODES, '26'),
    investing: prefixes(process.env.CASHFLOW_INVESTING_CODES, '11,12,13'),
    financing: prefixes(process.env.CASHFLOW_FINANCING_CODES, '51,52'),
  };

  const movement = await accountBalances(tx, ctx, range); // debit-normal postings in [from,to]
  const cumulative = await accountBalances(tx, ctx, { to: range.to });
  const opening = await accountBalances(tx, ctx, { to: dayBefore(range.from) });

  const cashCents = (rows: DatedBalanceRow[]): bigint =>
    rows.reduce((s, r) => (classifyActivity(r, cfg) === 'cash' ? s + toCents(r.balance) : s), 0n);

  const closingCashCents = cashCents(cumulative);
  const openingCashCents = cashCents(opening);

  let netProfitCents = 0n;
  const workingCapital: CashFlowLine[] = [];
  const investing: CashFlowLine[] = [];
  const financing: CashFlowLine[] = [];
  let wcCents = 0n, invCents = 0n, finCents = 0n;

  for (const r of movement) {
    const activity = classifyActivity(r, cfg);
    if (activity === 'cash') continue;
    // Cash-flow contribution = negated debit-normal movement (cash rises when a
    // non-cash debit-normal balance falls).
    const amount = -toCents(r.balance);
    if (activity === 'operating') {
      if (r.type === 'income' || r.type === 'expense') {
        netProfitCents += amount; // folds into the net-profit starting line
        continue;
      }
      if (amount === 0n) continue;
      workingCapital.push({ code: r.code, name: r.name, amount: fromCents(amount) });
      wcCents += amount;
    } else if (activity === 'investing') {
      if (amount === 0n) continue;
      investing.push({ code: r.code, name: r.name, amount: fromCents(amount) });
      invCents += amount;
    } else {
      if (amount === 0n) continue;
      financing.push({ code: r.code, name: r.name, amount: fromCents(amount) });
      finCents += amount;
    }
  }

  const operatingSubtotalCents = netProfitCents + wcCents;
  const netChangeCents = operatingSubtotalCents + invCents + finCents;

  return {
    from: range.from,
    to: range.to,
    netProfit: fromCents(netProfitCents),
    workingCapital,
    operatingSubtotal: fromCents(operatingSubtotalCents),
    investing,
    investingSubtotal: fromCents(invCents),
    financing,
    financingSubtotal: fromCents(finCents),
    netChange: fromCents(netChangeCents),
    openingCash: fromCents(openingCashCents),
    closingCash: fromCents(closingCashCents),
    reconciles: openingCashCents + netChangeCents === closingCashCents,
  };
}

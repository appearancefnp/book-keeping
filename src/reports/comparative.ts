import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { profitAndLoss, type StatementSection, type StatementLine } from './profit-and-loss.js';
import { balanceSheet } from './balance-sheet.js';
import { toCents, fromCents } from '../db/money.js';

export interface ComparativeLine {
  code: string; name: string;
  current: string; comparison: string; variance: string; variancePct: string | null;
}
export interface ComparativeSection {
  lines: ComparativeLine[]; current: string; comparison: string; variance: string; variancePct: string | null;
}
export interface ComparativeProfitAndLoss {
  current: { from: string; to: string }; comparison: { from: string; to: string };
  income: ComparativeSection; expense: ComparativeSection; netProfit: ComparativeLine;
}
export interface ComparativeBalanceSheet {
  asOf: string; comparisonAsOf: string;
  assets: ComparativeSection; liabilities: ComparativeSection; equity: ComparativeSection;
  currentPeriodResult: ComparativeLine; totalAssets: ComparativeLine; totalLiabilitiesAndEquity: ComparativeLine;
}

/** Display-only % change; null when the comparison base is zero (never divide-by-zero). */
function pct(varianceCents: bigint, comparisonCents: bigint): string | null {
  if (comparisonCents === 0n) return null;
  const p = (Number(varianceCents) / Math.abs(Number(comparisonCents))) * 100;
  return p.toFixed(1);
}

function line(code: string, name: string, curCents: bigint, cmpCents: bigint): ComparativeLine {
  const v = curCents - cmpCents;
  return { code, name, current: fromCents(curCents), comparison: fromCents(cmpCents), variance: fromCents(v), variancePct: pct(v, cmpCents) };
}

/** Full-outer-join two statement sections by account code; account in only one period → other side 0. */
function mergeSections(cur: StatementSection, cmp: StatementSection): ComparativeSection {
  const curByCode = new Map<string, StatementLine>(cur.lines.map((l) => [l.code, l]));
  const cmpByCode = new Map<string, StatementLine>(cmp.lines.map((l) => [l.code, l]));
  const codes = [...new Set([...curByCode.keys(), ...cmpByCode.keys()])].sort();
  const lines = codes.map((code) => {
    const c = curByCode.get(code); const p = cmpByCode.get(code);
    return line(code, c?.name ?? p?.name ?? code, toCents(c?.amount ?? '0'), toCents(p?.amount ?? '0'));
  });
  const curSub = toCents(cur.subtotal); const cmpSub = toCents(cmp.subtotal);
  return { lines, current: fromCents(curSub), comparison: fromCents(cmpSub), variance: fromCents(curSub - cmpSub), variancePct: pct(curSub - cmpSub, cmpSub) };
}

export async function comparativeProfitAndLoss(
  tx: PoolClient, ctx: TenantContext,
  args: { current: { from: string; to: string }; comparison: { from: string; to: string } },
): Promise<ComparativeProfitAndLoss> {
  const cur = await profitAndLoss(tx, ctx, args.current);
  const cmp = await profitAndLoss(tx, ctx, args.comparison);
  return {
    current: args.current, comparison: args.comparison,
    income: mergeSections(cur.income, cmp.income),
    expense: mergeSections(cur.expense, cmp.expense),
    netProfit: line('', 'Net profit', toCents(cur.netProfit), toCents(cmp.netProfit)),
  };
}

export async function comparativeBalanceSheet(
  tx: PoolClient, ctx: TenantContext,
  args: { asOf: string; comparisonAsOf: string },
): Promise<ComparativeBalanceSheet> {
  const cur = await balanceSheet(tx, ctx, { asOf: args.asOf });
  const cmp = await balanceSheet(tx, ctx, { asOf: args.comparisonAsOf });
  return {
    asOf: args.asOf, comparisonAsOf: args.comparisonAsOf,
    assets: mergeSections(cur.assets, cmp.assets),
    liabilities: mergeSections(cur.liabilities, cmp.liabilities),
    equity: mergeSections(cur.equity, cmp.equity),
    currentPeriodResult: line('', 'Current-period result', toCents(cur.currentPeriodResult), toCents(cmp.currentPeriodResult)),
    totalAssets: line('', 'Total assets', toCents(cur.totalAssets), toCents(cmp.totalAssets)),
    totalLiabilitiesAndEquity: line('', 'Total liabilities & equity', toCents(cur.totalLiabilitiesAndEquity), toCents(cmp.totalLiabilitiesAndEquity)),
  };
}

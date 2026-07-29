import type { ProfitAndLoss, StatementSection } from './profit-and-loss.js';
import type { BalanceSheet } from './balance-sheet.js';
import type { ComparativeProfitAndLoss, ComparativeBalanceSheet, ComparativeSection, ComparativeLine } from './comparative.js';
import type { GeneralLedger } from './general-ledger.js';
import type { CashFlowStatement } from './cash-flow.js';
import type { StatementOfEquity } from './equity.js';
import type { DatedBalanceRow } from '../ledger/balances.js';
import type { ApAging } from '../payables/aging.js';
import type { ArAging } from '../receivables/aging.js';

export type CellKind = 'data' | 'subtotal' | 'section' | 'opening' | 'closing';
export interface ReportColumn { key: string; label: string; align: 'left' | 'right' }
export interface ReportRow { cells: string[]; kind: CellKind }
export interface ReportTable { title: string; meta: { label: string; value: string }[]; columns: ReportColumn[]; rows: ReportRow[] }

export interface ReportLabels {
  pl: string; bs: string; gl: string; trial: string; apAging: string; arAging: string;
  cashFlow: string; equityStmt: string;
  period: string; asOf: string; comparisonPeriod: string; client: string; generated: string;
  income: string; expense: string; assets: string; liabilities: string; equity: string;
  netProfit: string; currentResult: string; totalAssets: string; totalLiabEquity: string;
  operating: string; investing: string; financing: string; netChange: string; openingCash: string; closingCash: string;
  movement: string; resultForPeriod: string;
  code: string; account: string; amount: string; current: string; comparison: string; variance: string; variancePct: string;
  date: string; memo: string; description: string; debit: string; credit: string; balance: string; opening: string; closing: string; total: string;
  bucketCurrent: string; d1_30: string; d31_60: string; d61_90: string; d90plus: string;
}

const PCT = (v: string | null): string => (v === null ? '—' : v);
const nameFor = (code: string, name: string, labels: ReportLabels): string => (code === '' ? labels.currentResult : name);

// ---- single-period statements ----
function statementSection(title: string, s: StatementSection, labels: ReportLabels): ReportRow[] {
  const rows: ReportRow[] = [{ cells: [title, '', ''], kind: 'section' }];
  for (const l of s.lines) rows.push({ cells: [l.code, nameFor(l.code, l.name, labels), l.amount], kind: 'data' });
  rows.push({ cells: ['', title, s.subtotal], kind: 'subtotal' });
  return rows;
}

export function profitAndLossTable(pl: ProfitAndLoss, labels: ReportLabels, period: { from: string; to: string }): ReportTable {
  return {
    title: labels.pl,
    meta: [{ label: labels.period, value: `${period.from} – ${period.to}` }],
    columns: [
      { key: 'code', label: labels.code, align: 'left' },
      { key: 'account', label: labels.account, align: 'left' },
      { key: 'amount', label: labels.amount, align: 'right' },
    ],
    rows: [
      ...statementSection(labels.income, pl.income, labels),
      ...statementSection(labels.expense, pl.expense, labels),
      { cells: ['', labels.netProfit, pl.netProfit], kind: 'subtotal' },
    ],
  };
}

export function balanceSheetTable(bs: BalanceSheet, labels: ReportLabels): ReportTable {
  return {
    title: labels.bs,
    meta: [{ label: labels.asOf, value: bs.asOf }],
    columns: [
      { key: 'code', label: labels.code, align: 'left' },
      { key: 'account', label: labels.account, align: 'left' },
      { key: 'amount', label: labels.amount, align: 'right' },
    ],
    rows: [
      ...statementSection(labels.assets, bs.assets, labels),
      ...statementSection(labels.liabilities, bs.liabilities, labels),
      ...statementSection(labels.equity, bs.equity, labels),
      { cells: ['', labels.totalAssets, bs.totalAssets], kind: 'subtotal' },
      { cells: ['', labels.totalLiabEquity, bs.totalLiabilitiesAndEquity], kind: 'subtotal' },
    ],
  };
}

// ---- comparative statements ----
const cmpCols = (labels: ReportLabels): ReportColumn[] => [
  { key: 'code', label: labels.code, align: 'left' },
  { key: 'account', label: labels.account, align: 'left' },
  { key: 'current', label: labels.current, align: 'right' },
  { key: 'comparison', label: labels.comparison, align: 'right' },
  { key: 'variance', label: labels.variance, align: 'right' },
  { key: 'variancePct', label: labels.variancePct, align: 'right' },
];
function cmpLineRow(l: ComparativeLine, labels: ReportLabels, kind: CellKind = 'data', nameOverride?: string): ReportRow {
  const nm = nameOverride ?? nameFor(l.code, l.name, labels);
  return { cells: [l.code, nm, l.current, l.comparison, l.variance, PCT(l.variancePct)], kind };
}
function cmpSection(title: string, s: ComparativeSection, labels: ReportLabels): ReportRow[] {
  const rows: ReportRow[] = [{ cells: [title, '', '', '', '', ''], kind: 'section' }];
  for (const l of s.lines) rows.push(cmpLineRow(l, labels));
  rows.push({ cells: ['', title, s.current, s.comparison, s.variance, PCT(s.variancePct)], kind: 'subtotal' });
  return rows;
}

export function comparativeProfitAndLossTable(c: ComparativeProfitAndLoss, labels: ReportLabels): ReportTable {
  return {
    title: labels.pl,
    meta: [
      { label: labels.period, value: `${c.current.from} – ${c.current.to}` },
      { label: labels.comparisonPeriod, value: `${c.comparison.from} – ${c.comparison.to}` },
    ],
    columns: cmpCols(labels),
    rows: [...cmpSection(labels.income, c.income, labels), ...cmpSection(labels.expense, c.expense, labels), cmpLineRow(c.netProfit, labels, 'subtotal', labels.netProfit)],
  };
}

export function comparativeBalanceSheetTable(c: ComparativeBalanceSheet, labels: ReportLabels): ReportTable {
  return {
    title: labels.bs,
    meta: [
      { label: labels.asOf, value: c.asOf },
      { label: labels.comparisonPeriod, value: c.comparisonAsOf },
    ],
    columns: cmpCols(labels),
    rows: [
      ...cmpSection(labels.assets, c.assets, labels),
      ...cmpSection(labels.liabilities, c.liabilities, labels),
      ...cmpSection(labels.equity, c.equity, labels),
      cmpLineRow(c.totalAssets, labels, 'subtotal', labels.totalAssets),
      cmpLineRow(c.totalLiabilitiesAndEquity, labels, 'subtotal', labels.totalLiabEquity),
    ],
  };
}

// ---- general ledger ----
export function generalLedgerTable(gl: GeneralLedger, labels: ReportLabels): ReportTable {
  const rows: ReportRow[] = [];
  for (const a of gl.accounts) {
    rows.push({ cells: [`${a.code} — ${a.name}`, '', '', '', '', ''], kind: 'section' });
    rows.push({ cells: ['', labels.opening, '', '', '', a.opening], kind: 'opening' });
    for (const l of a.lines) rows.push({ cells: [l.date, l.memo, l.description ?? '', l.debit, l.credit, l.balance], kind: 'data' });
    rows.push({ cells: ['', labels.closing, '', a.totalDebit, a.totalCredit, a.closing], kind: 'closing' });
  }
  return {
    title: labels.gl,
    meta: [{ label: labels.period, value: `${gl.from} – ${gl.to}` }],
    columns: [
      { key: 'date', label: labels.date, align: 'left' },
      { key: 'memo', label: labels.memo, align: 'left' },
      { key: 'description', label: labels.description, align: 'left' },
      { key: 'debit', label: labels.debit, align: 'right' },
      { key: 'credit', label: labels.credit, align: 'right' },
      { key: 'balance', label: labels.balance, align: 'right' },
    ],
    rows,
  };
}

// ---- trial balance ----
export function trialBalanceTable(rows: DatedBalanceRow[], labels: ReportLabels, asOf: string): ReportTable {
  return {
    title: labels.trial,
    meta: [{ label: labels.asOf, value: asOf }],
    columns: [
      { key: 'code', label: labels.code, align: 'left' },
      { key: 'account', label: labels.account, align: 'left' },
      { key: 'debit', label: labels.debit, align: 'right' },
      { key: 'credit', label: labels.credit, align: 'right' },
      { key: 'balance', label: labels.balance, align: 'right' },
    ],
    rows: rows.map((r) => ({ cells: [r.code, r.name, r.debit, r.credit, r.balance], kind: 'data' as CellKind })),
  };
}

// ---- AP aging ----
export function apAgingTable(aging: ApAging, labels: ReportLabels): ReportTable {
  return {
    title: labels.apAging,
    meta: [{ label: labels.asOf, value: aging.asOf }],
    columns: [
      { key: 'current', label: labels.bucketCurrent, align: 'right' },
      { key: 'd1_30', label: labels.d1_30, align: 'right' },
      { key: 'd31_60', label: labels.d31_60, align: 'right' },
      { key: 'd61_90', label: labels.d61_90, align: 'right' },
      { key: 'd90plus', label: labels.d90plus, align: 'right' },
      { key: 'total', label: labels.total, align: 'right' },
    ],
    rows: [{ cells: [aging.current, aging.d1_30, aging.d31_60, aging.d61_90, aging.d90plus, aging.total], kind: 'data' }],
  };
}

// ---- cash flow (indirect) ----
export function cashFlowTable(cf: CashFlowStatement, labels: ReportLabels): ReportTable {
  const rows: ReportRow[] = [];
  rows.push({ cells: [labels.operating, '', ''], kind: 'section' });
  rows.push({ cells: ['', labels.netProfit, cf.netProfit], kind: 'data' });
  for (const l of cf.workingCapital) rows.push({ cells: [l.code, l.name, l.amount], kind: 'data' });
  rows.push({ cells: ['', labels.operating, cf.operatingSubtotal], kind: 'subtotal' });
  rows.push({ cells: [labels.investing, '', ''], kind: 'section' });
  for (const l of cf.investing) rows.push({ cells: [l.code, l.name, l.amount], kind: 'data' });
  rows.push({ cells: ['', labels.investing, cf.investingSubtotal], kind: 'subtotal' });
  rows.push({ cells: [labels.financing, '', ''], kind: 'section' });
  for (const l of cf.financing) rows.push({ cells: [l.code, l.name, l.amount], kind: 'data' });
  rows.push({ cells: ['', labels.financing, cf.financingSubtotal], kind: 'subtotal' });
  rows.push({ cells: ['', labels.netChange, cf.netChange], kind: 'subtotal' });
  rows.push({ cells: ['', labels.openingCash, cf.openingCash], kind: 'opening' });
  rows.push({ cells: ['', labels.closingCash, cf.closingCash], kind: 'closing' });
  return {
    title: labels.cashFlow,
    meta: [{ label: labels.period, value: `${cf.from} – ${cf.to}` }],
    columns: [
      { key: 'code', label: labels.code, align: 'left' },
      { key: 'account', label: labels.account, align: 'left' },
      { key: 'amount', label: labels.amount, align: 'right' },
    ],
    rows,
  };
}

// ---- statement of equity ----
export function statementOfEquityTable(eq: StatementOfEquity, labels: ReportLabels): ReportTable {
  const rows: ReportRow[] = [];
  for (const a of eq.accounts) rows.push({ cells: [a.code, a.name, a.opening, a.movement, a.closing], kind: 'data' });
  rows.push({ cells: ['', labels.resultForPeriod, eq.result.opening, eq.result.movement, eq.result.closing], kind: 'data' });
  rows.push({ cells: ['', labels.total, eq.openingTotal, eq.movementTotal, eq.closingTotal], kind: 'subtotal' });
  return {
    title: labels.equityStmt,
    meta: [{ label: labels.period, value: `${eq.from} – ${eq.to}` }],
    columns: [
      { key: 'code', label: labels.code, align: 'left' },
      { key: 'account', label: labels.account, align: 'left' },
      { key: 'opening', label: labels.opening, align: 'right' },
      { key: 'movement', label: labels.movement, align: 'right' },
      { key: 'closing', label: labels.closing, align: 'right' },
    ],
    rows,
  };
}

// ---- AR aging ----
export function arAgingTable(aging: ArAging, labels: ReportLabels): ReportTable {
  return {
    title: labels.arAging,
    meta: [{ label: labels.asOf, value: aging.asOf }],
    columns: [
      { key: 'current', label: labels.bucketCurrent, align: 'right' },
      { key: 'd1_30', label: labels.d1_30, align: 'right' },
      { key: 'd31_60', label: labels.d31_60, align: 'right' },
      { key: 'd61_90', label: labels.d61_90, align: 'right' },
      { key: 'd90plus', label: labels.d90plus, align: 'right' },
      { key: 'total', label: labels.total, align: 'right' },
    ],
    rows: [{ cells: [aging.current, aging.d1_30, aging.d31_60, aging.d61_90, aging.d90plus, aging.total], kind: 'data' }],
  };
}

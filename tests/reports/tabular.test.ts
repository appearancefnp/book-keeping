import { expect, test } from 'vitest';
import {
  profitAndLossTable, comparativeProfitAndLossTable, balanceSheetTable, comparativeBalanceSheetTable,
  generalLedgerTable, trialBalanceTable, apAgingTable, arAgingTable,
  cashFlowTable, statementOfEquityTable, type ReportLabels,
} from '../../src/reports/tabular.js';

// Minimal English fixture labels (the web route supplies real translations).
const L: ReportLabels = {
  pl: 'Profit & Loss', bs: 'Balance Sheet', gl: 'General Ledger', trial: 'Trial Balance', apAging: 'Aged Payables', arAging: 'Aged Receivables',
  cashFlow: 'Cash Flow', equityStmt: 'Statement of Equity',
  period: 'Period', asOf: 'As of', comparisonPeriod: 'Comparison', client: 'Client', generated: 'Generated',
  income: 'Income', expense: 'Expenses', assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity',
  netProfit: 'Net profit', currentResult: 'Current-period result', totalAssets: 'Total assets', totalLiabEquity: 'Total liabilities & equity',
  operating: 'Operating activities', investing: 'Investing activities', financing: 'Financing activities',
  netChange: 'Net change in cash', openingCash: 'Cash at start', closingCash: 'Cash at end',
  movement: 'Change', resultForPeriod: 'Result for the period',
  code: 'Code', account: 'Account', amount: 'Amount', current: 'Current', comparison: 'Comparison', variance: 'Variance', variancePct: 'Variance %',
  date: 'Date', memo: 'Memo', description: 'Description', debit: 'Debit', credit: 'Credit', balance: 'Balance', opening: 'Opening', closing: 'Closing', total: 'Total',
  bucketCurrent: 'Current', d1_30: '1–30', d31_60: '31–60', d61_90: '61–90', d90plus: '90+',
};

test('profitAndLossTable lays out income + expense sections with subtotals and net', () => {
  const pl = {
    from: '2026-03-01', to: '2026-03-31',
    income: { lines: [{ code: '6110', name: 'Sales', amount: '300.00' }], subtotal: '300.00' },
    expense: { lines: [{ code: '7710', name: 'Expenses', amount: '120.00' }], subtotal: '120.00' },
    netProfit: '180.00',
  };
  const t = profitAndLossTable(pl, L, { from: '2026-03-01', to: '2026-03-31' });
  expect(t.title).toBe('Profit & Loss');
  expect(t.columns.map((c) => c.key)).toEqual(['code', 'account', 'amount']);
  // section header + line + subtotal for income, same for expense, then net
  const kinds = t.rows.map((r) => r.kind);
  expect(kinds).toContain('section');
  expect(kinds).toContain('subtotal');
  const net = t.rows.at(-1)!;
  expect(net.cells).toEqual(['', 'Net profit', '180.00']);
});

test('comparativeProfitAndLossTable adds comparison/variance/variance% columns', () => {
  const c = {
    current: { from: '2026-03-01', to: '2026-03-31' }, comparison: { from: '2026-02-01', to: '2026-02-28' },
    income: { lines: [{ code: '6110', name: 'Sales', current: '300.00', comparison: '100.00', variance: '200.00', variancePct: '200.0' }], current: '300.00', comparison: '100.00', variance: '200.00', variancePct: '200.0' },
    expense: { lines: [{ code: '7710', name: 'Expenses', current: '60.00', comparison: '0.00', variance: '60.00', variancePct: null }], current: '60.00', comparison: '0.00', variance: '60.00', variancePct: null },
    netProfit: { code: '', name: 'Net profit', current: '240.00', comparison: '100.00', variance: '140.00', variancePct: '140.0' },
  };
  const t = comparativeProfitAndLossTable(c, L);
  expect(t.columns.map((c) => c.key)).toEqual(['code', 'account', 'current', 'comparison', 'variance', 'variancePct']);
  const exp = t.rows.find((r) => r.cells[0] === '7710')!;
  expect(exp.cells).toEqual(['7710', 'Expenses', '60.00', '0.00', '60.00', '—']); // null pct → —
});

test('generalLedgerTable emits section/opening/data/closing rows per account', () => {
  const gl = {
    from: '2026-03-01', to: '2026-03-31',
    accounts: [{
      code: '2620', name: 'Bank', opening: '100.00', closing: '350.00', totalDebit: '300.00', totalCredit: '50.00',
      lines: [
        { entryId: 'e1', date: '2026-03-10', memo: 'Sale', description: 'in', debit: '300.00', credit: '0.00', balance: '400.00' },
        { entryId: 'e2', date: '2026-03-15', memo: 'Refund', description: null, debit: '0.00', credit: '50.00', balance: '350.00' },
      ],
    }],
  };
  const t = generalLedgerTable(gl, L);
  expect(t.columns.map((c) => c.key)).toEqual(['date', 'memo', 'description', 'debit', 'credit', 'balance']);
  expect(t.rows[0]!.kind).toBe('section');       // "2620 — Bank"
  expect(t.rows[1]!.kind).toBe('opening');
  expect(t.rows.at(-1)!.kind).toBe('closing');
});

test('trialBalanceTable and apAgingTable produce expected columns', () => {
  const tb = trialBalanceTable(
    [{ code: '2620', name: 'Bank', debit: '340.00', credit: '0.00', balance: '340.00', type: 'asset' }],
    L, '2026-03-31',
  );
  expect(tb.columns.map((c) => c.key)).toEqual(['code', 'account', 'debit', 'credit', 'balance']);
  const aging = apAgingTable(
    { asOf: '2026-06-15', current: '60.00', d1_30: '0.00', d31_60: '0.00', d61_90: '0.00', d90plus: '0.00', total: '60.00' }, L);
  expect(aging.columns.map((c) => c.key)).toEqual(['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus', 'total']);
  expect(aging.rows[0]!.cells).toEqual(['60.00', '0.00', '0.00', '0.00', '0.00', '60.00']);
});

test('arAgingTable produces the same columns/layout as apAgingTable, buckets can be negative', () => {
  const aging = arAgingTable(
    { asOf: '2026-06-15', current: '60.00', d1_30: '0.00', d31_60: '-10.00', d61_90: '0.00', d90plus: '0.00', total: '50.00' }, L);
  expect(aging.title).toBe('Aged Receivables');
  expect(aging.meta).toEqual([{ label: 'As of', value: '2026-06-15' }]);
  expect(aging.columns.map((c) => c.key)).toEqual(['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus', 'total']);
  expect(aging.rows[0]!.cells).toEqual(['60.00', '0.00', '-10.00', '0.00', '0.00', '50.00']);
  expect(aging.rows[0]!.kind).toBe('data');
});

// Labels whose text deliberately DIFFERS from the upstream English `name` strings baked into
// the report fixtures below, so a serializer that ever falls back to `l.name` for a ''-coded
// line would fail these assertions instead of silently passing with English text.
const M: ReportLabels = {
  ...L,
  netProfit: 'NET', currentResult: 'REZ', totalAssets: 'TA', totalLiabEquity: 'TLE',
};

test('balanceSheetTable localizes the "" -coded equity result line via labels.currentResult', () => {
  const bs = {
    asOf: '2026-03-31',
    assets: { lines: [{ code: '1000', name: 'Cash', amount: '500.00' }], subtotal: '500.00' },
    liabilities: { lines: [{ code: '2000', name: 'Payables', amount: '100.00' }], subtotal: '100.00' },
    // '' code + hardcoded English name, exactly as balance-sheet.ts produces for the current-period result line.
    equity: { lines: [{ code: '', name: 'Current-period result', amount: '400.00' }], subtotal: '400.00' },
    currentPeriodResult: '400.00', totalAssets: '500.00', totalLiabilitiesAndEquity: '500.00', balanced: true,
  };
  const t = balanceSheetTable(bs, M);
  const resultRow = t.rows.find((r) => r.cells[0] === '' && r.kind === 'data')!;
  expect(resultRow.cells[1]).toBe('REZ');
  expect(resultRow.cells[1]).not.toBe('Current-period result');
});

test('comparativeProfitAndLossTable localizes the netProfit line via labels.netProfit', () => {
  const c = {
    current: { from: '2026-03-01', to: '2026-03-31' }, comparison: { from: '2026-02-01', to: '2026-02-28' },
    income: { lines: [{ code: '6110', name: 'Sales', current: '300.00', comparison: '100.00', variance: '200.00', variancePct: '200.0' }], current: '300.00', comparison: '100.00', variance: '200.00', variancePct: '200.0' },
    expense: { lines: [{ code: '7710', name: 'Expenses', current: '60.00', comparison: '0.00', variance: '60.00', variancePct: null }], current: '60.00', comparison: '0.00', variance: '60.00', variancePct: null },
    // '' code + hardcoded English name, as comparative.ts produces via line('', 'Net profit', ...).
    netProfit: { code: '', name: 'Net profit', current: '240.00', comparison: '100.00', variance: '140.00', variancePct: '140.0' },
  };
  const t = comparativeProfitAndLossTable(c, M);
  const netRow = t.rows.at(-1)!;
  expect(netRow.cells[1]).toBe('NET');
  expect(netRow.cells[1]).not.toBe('Net profit');
});

test('comparativeBalanceSheetTable localizes totalAssets/totalLiabilitiesAndEquity via labels', () => {
  const c = {
    asOf: '2026-03-31', comparisonAsOf: '2026-02-28',
    assets: { lines: [{ code: '1000', name: 'Cash', current: '500.00', comparison: '400.00', variance: '100.00', variancePct: '25.0' }], current: '500.00', comparison: '400.00', variance: '100.00', variancePct: '25.0' },
    liabilities: { lines: [{ code: '2000', name: 'Payables', current: '100.00', comparison: '80.00', variance: '20.00', variancePct: '25.0' }], current: '100.00', comparison: '80.00', variance: '20.00', variancePct: '25.0' },
    equity: { lines: [{ code: '3000', name: 'Capital', current: '400.00', comparison: '320.00', variance: '80.00', variancePct: '25.0' }], current: '400.00', comparison: '320.00', variance: '80.00', variancePct: '25.0' },
    // '' code + hardcoded English names, as comparative.ts produces via line('', 'Total assets', ...) etc.
    currentPeriodResult: { code: '', name: 'Current-period result', current: '0.00', comparison: '0.00', variance: '0.00', variancePct: null },
    totalAssets: { code: '', name: 'Total assets', current: '500.00', comparison: '400.00', variance: '100.00', variancePct: '25.0' },
    totalLiabilitiesAndEquity: { code: '', name: 'Total liabilities & equity', current: '500.00', comparison: '400.00', variance: '100.00', variancePct: '25.0' },
  };
  const t = comparativeBalanceSheetTable(c, M);
  const rows = t.rows.filter((r) => r.kind === 'subtotal');
  expect(rows.at(-2)!.cells[1]).toBe('TA');
  expect(rows.at(-2)!.cells[1]).not.toBe('Total assets');
  expect(rows.at(-1)!.cells[1]).toBe('TLE');
  expect(rows.at(-1)!.cells[1]).not.toBe('Total liabilities & equity');
});

test('cashFlowTable lays out the three activity sections with a reconciliation tail', () => {
  const cf = {
    from: '2026-03-01', to: '2026-03-31', netProfit: '120.00',
    workingCapital: [{ code: '2310', name: 'Debtors', amount: '-100.00' }], operatingSubtotal: '20.00',
    investing: [{ code: '1210', name: 'Fixed assets', amount: '-800.00' }], investingSubtotal: '-800.00',
    financing: [{ code: '3300', name: 'Capital', amount: '1000.00' }], financingSubtotal: '1000.00',
    netChange: '220.00', openingCash: '0.00', closingCash: '220.00', reconciles: true,
  };
  const t = cashFlowTable(cf, L);
  expect(t.title).toBe('Cash Flow');
  expect(t.rows.filter((r) => r.kind === 'section')).toHaveLength(3); // operating/investing/financing
  // net-profit line leads the operating section
  const first = t.rows.find((r) => r.kind === 'data')!;
  expect(first.cells).toEqual(['', 'Net profit', '120.00']);
  const opening = t.rows.find((r) => r.kind === 'opening')!;
  const closing = t.rows.find((r) => r.kind === 'closing')!;
  expect(opening.cells).toEqual(['', 'Cash at start', '0.00']);
  expect(closing.cells).toEqual(['', 'Cash at end', '220.00']);
});

test('statementOfEquityTable appends the result line and a totals subtotal', () => {
  const eq = {
    from: '2026-03-01', to: '2026-03-31',
    accounts: [{ code: '3300', name: 'Capital', opening: '1000.00', movement: '-200.00', closing: '800.00' }],
    result: { opening: '0.00', movement: '180.00', closing: '180.00' },
    openingTotal: '1000.00', movementTotal: '-20.00', closingTotal: '980.00', balanced: true,
  };
  const t = statementOfEquityTable(eq, L);
  expect(t.title).toBe('Statement of Equity');
  expect(t.columns.map((c) => c.key)).toEqual(['code', 'account', 'opening', 'movement', 'closing']);
  const resultRow = t.rows.find((r) => r.cells[1] === 'Result for the period')!;
  expect(resultRow.cells).toEqual(['', 'Result for the period', '0.00', '180.00', '180.00']);
  const totals = t.rows.find((r) => r.kind === 'subtotal')!;
  expect(totals.cells).toEqual(['', 'Total', '1000.00', '-20.00', '980.00']);
});

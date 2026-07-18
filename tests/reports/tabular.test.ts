import { expect, test } from 'vitest';
import {
  profitAndLossTable, comparativeProfitAndLossTable, balanceSheetTable,
  generalLedgerTable, trialBalanceTable, apAgingTable, type ReportLabels,
} from '../../src/reports/tabular.js';

// Minimal English fixture labels (the web route supplies real translations).
const L: ReportLabels = {
  pl: 'Profit & Loss', bs: 'Balance Sheet', gl: 'General Ledger', trial: 'Trial Balance', apAging: 'Aged Payables',
  period: 'Period', asOf: 'As of', comparisonPeriod: 'Comparison', client: 'Client', generated: 'Generated',
  income: 'Income', expense: 'Expenses', assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity',
  netProfit: 'Net profit', currentResult: 'Current-period result', totalAssets: 'Total assets', totalLiabEquity: 'Total liabilities & equity',
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

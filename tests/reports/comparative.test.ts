import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { comparativeProfitAndLoss, comparativeBalanceSheet } from '../../src/reports/comparative.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seed() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    for (const m of [2, 3]) await openPeriod(tx, ctx(t), { year: 2026, month: m });
    // Feb: sales 100
    await postEntry(tx, ctx(t), { date: '2026-02-10', memo: 'Feb sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '100.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
    ]});
    // Mar: sales 300 + expense 60
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Mar sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '300.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '300.00' },
    ]});
    await postEntry(tx, ctx(t), { date: '2026-03-12', memo: 'Mar cost', currency: 'EUR', lines: [
      { accountCode: '7710', debit: '60.00', credit: '0' },
      { accountCode: '2620', debit: '0', credit: '60.00' },
    ]});
  });
  return t;
}

test('comparativeProfitAndLoss computes variance and % vs comparison', async () => {
  const t = await seed();
  const c = await withTenant(ctx(t), (tx) => comparativeProfitAndLoss(tx, ctx(t), {
    current: { from: '2026-03-01', to: '2026-03-31' },
    comparison: { from: '2026-02-01', to: '2026-02-28' },
  }));
  const sales = c.income.lines.find((l) => l.code === '6110')!;
  expect(sales).toMatchObject({ current: '300.00', comparison: '100.00', variance: '200.00', variancePct: '200.0' });
  // Expense present only in March → comparison side 0, pct null (zero base)
  const exp = c.expense.lines.find((l) => l.code === '7710')!;
  expect(exp).toMatchObject({ current: '60.00', comparison: '0.00', variance: '60.00', variancePct: null });
  expect(c.netProfit).toMatchObject({ current: '240.00', comparison: '100.00', variance: '140.00' });
});

test('an account present only in the comparison period fills the current side with 0.00', async () => {
  const t = await seed();
  // Reverse direction: current = Feb (no expense), comparison = March (expense 60) → 7710 only in comparison.
  const c = await withTenant(ctx(t), (tx) => comparativeProfitAndLoss(tx, ctx(t), {
    current: { from: '2026-02-01', to: '2026-02-28' },
    comparison: { from: '2026-03-01', to: '2026-03-31' },
  }));
  const exp = c.expense.lines.find((l) => l.code === '7710')!;
  expect(exp).toMatchObject({ current: '0.00', comparison: '60.00', variance: '-60.00', variancePct: '-100.0' });
});

test('comparativeBalanceSheet computes variance between two as-of dates', async () => {
  const t = await seed();
  const c = await withTenant(ctx(t), (tx) => comparativeBalanceSheet(tx, ctx(t), {
    asOf: '2026-03-31', comparisonAsOf: '2026-02-28',
  }));
  const bank = c.assets.lines.find((l) => l.code === '2620')!;
  expect(bank).toMatchObject({ current: '340.00', comparison: '100.00', variance: '240.00' }); // 100+300-60 vs 100
  expect(c.totalAssets.current).toBe('340.00');
  expect(c.totalAssets.comparison).toBe('100.00');
});

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry, reverseEntry } from '../../src/ledger/posting.js';
import { profitAndLoss } from '../../src/reports/profit-and-loss.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function base() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 4 });
  });
  return t;
}

test('profitAndLoss computes income, expense, and net', async () => {
  const t = await base();
  await withTenant(ctx(t), async (tx) => {
    // Sale 300: DR bank / CR sales
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '300.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '300.00' },
    ]});
    // Expense 120: DR expenses / CR bank
    await postEntry(tx, ctx(t), { date: '2026-03-12', memo: 'Cost', currency: 'EUR', lines: [
      { accountCode: '7710', debit: '120.00', credit: '0' },
      { accountCode: '2620', debit: '0', credit: '120.00' },
    ]});
  });
  const pl = await withTenant(ctx(t), (tx) => profitAndLoss(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(pl.income.subtotal).toBe('300.00');
  expect(pl.expense.subtotal).toBe('120.00');
  expect(pl.netProfit).toBe('180.00');
  expect(pl.income.lines).toHaveLength(1);
  expect(pl.income.lines[0]).toMatchObject({ code: '6110', amount: '300.00' });
  expect(pl.expense.lines[0]).toMatchObject({ code: '7710', amount: '120.00' });
});

test('profitAndLoss omits zero-balance accounts and asset/liability accounts', async () => {
  const t = await base();
  await withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
    { accountCode: '2620', debit: '50.00', credit: '0' },
    { accountCode: '6110', debit: '0', credit: '50.00' },
  ]}));
  const pl = await withTenant(ctx(t), (tx) => profitAndLoss(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(pl.income.lines).toHaveLength(1);   // sales only
  expect(pl.expense.lines).toHaveLength(0);   // 7710 has zero balance → omitted
});

test('profitAndLoss excludes entries outside the date range', async () => {
  const t = await base();
  await withTenant(ctx(t), async (tx) => {
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Mar', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '100.00', credit: '0' }, { accountCode: '6110', debit: '0', credit: '100.00' },
    ]});
    await postEntry(tx, ctx(t), { date: '2026-04-10', memo: 'Apr', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '999.00', credit: '0' }, { accountCode: '6110', debit: '0', credit: '999.00' },
    ]});
  });
  const pl = await withTenant(ctx(t), (tx) => profitAndLoss(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(pl.income.subtotal).toBe('100.00');
});

test('profitAndLoss reports a net loss when expenses exceed income', async () => {
  const t = await base();
  await withTenant(ctx(t), async (tx) => {
    // Sale 50: DR bank / CR sales
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '50.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '50.00' },
    ]});
    // Expense 120: DR expenses / CR bank
    await postEntry(tx, ctx(t), { date: '2026-03-12', memo: 'Cost', currency: 'EUR', lines: [
      { accountCode: '7710', debit: '120.00', credit: '0' },
      { accountCode: '2620', debit: '0', credit: '120.00' },
    ]});
  });
  const pl = await withTenant(ctx(t), (tx) => profitAndLoss(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(pl.income.subtotal).toBe('50.00');
  expect(pl.expense.subtotal).toBe('120.00');
  expect(pl.netProfit).toBe('-70.00');
});

test('profitAndLoss nets out a reversal', async () => {
  const t = await base();
  const posted = await withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
    { accountCode: '2620', debit: '80.00', credit: '0' }, { accountCode: '6110', debit: '0', credit: '80.00' },
  ]}));
  await withTenant(ctx(t), (tx) => reverseEntry(tx, ctx(t), posted.entryId, 'oops'));
  const pl = await withTenant(ctx(t), (tx) => profitAndLoss(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(pl.income.subtotal).toBe('0.00');
  expect(pl.netProfit).toBe('0.00');
});

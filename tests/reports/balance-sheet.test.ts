import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { balanceSheet } from '../../src/reports/balance-sheet.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seed() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await createAccount(tx, ctx(t), { code: '3300', name: 'Share capital', type: 'equity' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    // Owner injects capital: DR bank 1000 / CR equity 1000
    await postEntry(tx, ctx(t), { date: '2026-03-01', memo: 'Capital', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '1000.00', credit: '0' },
      { accountCode: '3300', debit: '0', credit: '1000.00' },
    ]});
    // Sale 300 on credit: DR bank 300 / CR sales 300
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '300.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '300.00' },
    ]});
    // Buy on credit: DR expenses 120 / CR payables 120
    await postEntry(tx, ctx(t), { date: '2026-03-12', memo: 'Cost', currency: 'EUR', lines: [
      { accountCode: '7710', debit: '120.00', credit: '0' },
      { accountCode: '5310', debit: '0', credit: '120.00' },
    ]});
  });
  return t;
}

test('balanceSheet classifies and balances', async () => {
  const t = await seed();
  const bs = await withTenant(ctx(t), (tx) => balanceSheet(tx, ctx(t), { asOf: '2026-03-31' }));
  expect(bs.totalAssets).toBe('1300.00');            // bank 1000 + 300
  expect(bs.currentPeriodResult).toBe('180.00');     // sales 300 - expenses 120
  expect(bs.totalLiabilitiesAndEquity).toBe('1300.00'); // payables 120 + capital 1000 + result 180
  expect(bs.balanced).toBe(true);
});

test('balanceSheet includes the current-period result as an equity line', async () => {
  const t = await seed();
  const bs = await withTenant(ctx(t), (tx) => balanceSheet(tx, ctx(t), { asOf: '2026-03-31' }));
  const resultLine = bs.equity.lines.find((l) => l.name === 'Current-period result');
  expect(resultLine?.amount).toBe('180.00');
  expect(bs.equity.subtotal).toBe('1180.00'); // capital 1000 + result 180
});

test('balanceSheet respects asOf (later entries excluded)', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '3300', name: 'Capital', type: 'equity' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 4 });
    await postEntry(tx, ctx(t), { date: '2026-03-01', memo: 'Capital', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '500.00', credit: '0' }, { accountCode: '3300', debit: '0', credit: '500.00' },
    ]});
    await postEntry(tx, ctx(t), { date: '2026-04-01', memo: 'More', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '500.00', credit: '0' }, { accountCode: '3300', debit: '0', credit: '500.00' },
    ]});
  });
  const bs = await withTenant(ctx(t), (tx) => balanceSheet(tx, ctx(t), { asOf: '2026-03-31' }));
  expect(bs.totalAssets).toBe('500.00');
  expect(bs.balanced).toBe(true);
});

test('balanceSheet reflects a net loss as a negative current-period result', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '3300', name: 'Share capital', type: 'equity' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    // Owner injects capital: DR bank 1000 / CR equity 1000
    await postEntry(tx, ctx(t), { date: '2026-03-01', memo: 'Capital', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '1000.00', credit: '0' },
      { accountCode: '3300', debit: '0', credit: '1000.00' },
    ]});
    // Sale 50: DR bank / CR sales
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '50.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '50.00' },
    ]});
    // Expense 120 paid from bank: DR expenses / CR bank
    await postEntry(tx, ctx(t), { date: '2026-03-12', memo: 'Cost', currency: 'EUR', lines: [
      { accountCode: '7710', debit: '120.00', credit: '0' },
      { accountCode: '2620', debit: '0', credit: '120.00' },
    ]});
  });
  const bs = await withTenant(ctx(t), (tx) => balanceSheet(tx, ctx(t), { asOf: '2026-03-31' }));
  expect(bs.currentPeriodResult).toBe('-70.00');
  const resultLine = bs.equity.lines.find((l) => l.name === 'Current-period result');
  expect(resultLine?.amount).toBe('-70.00');
  expect(bs.totalAssets).toBe('930.00');
  expect(bs.equity.subtotal).toBe('930.00'); // capital 1000 + result -70
  expect(bs.balanced).toBe(true);
});

test('empty ledger is balanced at zero', async () => {
  const t = await makeFirmAndClient();
  const bs = await withTenant(ctx(t), (tx) => balanceSheet(tx, ctx(t), { asOf: '2026-03-31' }));
  expect(bs.totalAssets).toBe('0.00');
  expect(bs.totalLiabilitiesAndEquity).toBe('0.00');
  expect(bs.balanced).toBe(true);
  expect(bs.currentPeriodResult).toBe('0.00');
});

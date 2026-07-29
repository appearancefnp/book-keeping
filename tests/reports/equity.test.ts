import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { statementOfEquity } from '../../src/reports/equity.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('statement of equity: opening, contributions/withdrawals, result, closing', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '3300', name: 'Share capital', type: 'equity' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 2 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    // February: capital injection (before the reporting period)
    await postEntry(tx, ctx(t), { date: '2026-02-10', memo: 'Capital', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '1000.00', credit: '0' }, { accountCode: '3300', debit: '0', credit: '1000.00' },
    ]});
    // March: dividend/withdrawal 200
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Withdrawal', currency: 'EUR', lines: [
      { accountCode: '3300', debit: '200.00', credit: '0' }, { accountCode: '2620', debit: '0', credit: '200.00' },
    ]});
    // March: sale 300
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '300.00', credit: '0' }, { accountCode: '6110', debit: '0', credit: '300.00' },
    ]});
    // March: expense 120
    await postEntry(tx, ctx(t), { date: '2026-03-12', memo: 'Cost', currency: 'EUR', lines: [
      { accountCode: '7710', debit: '120.00', credit: '0' }, { accountCode: '2620', debit: '0', credit: '120.00' },
    ]});
  });

  const eq = await withTenant(ctx(t), (tx) => statementOfEquity(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));

  const capital = eq.accounts.find((a) => a.code === '3300')!;
  expect(capital.opening).toBe('1000.00');   // carried from February
  expect(capital.movement).toBe('-200.00');  // withdrawal
  expect(capital.closing).toBe('800.00');

  expect(eq.result.opening).toBe('0.00');
  expect(eq.result.movement).toBe('180.00'); // sales 300 - expenses 120, this period
  expect(eq.result.closing).toBe('180.00');

  expect(eq.openingTotal).toBe('1000.00');
  expect(eq.movementTotal).toBe('-20.00');   // -200 withdrawal + 180 result
  expect(eq.closingTotal).toBe('980.00');
  expect(eq.balanced).toBe(true);
});

test('equity account with no in-period movement still appears with its opening', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '3300', name: 'Share capital', type: 'equity' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 2 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), { date: '2026-02-10', memo: 'Capital', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '500.00', credit: '0' }, { accountCode: '3300', debit: '0', credit: '500.00' },
    ]});
  });
  const eq = await withTenant(ctx(t), (tx) => statementOfEquity(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  const capital = eq.accounts.find((a) => a.code === '3300')!;
  expect(capital.opening).toBe('500.00');
  expect(capital.movement).toBe('0.00');
  expect(capital.closing).toBe('500.00');
  expect(eq.balanced).toBe(true);
});

test('empty ledger: no equity lines, zero totals', async () => {
  const t = await makeFirmAndClient();
  const eq = await withTenant(ctx(t), (tx) => statementOfEquity(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(eq.accounts).toHaveLength(0);
  expect(eq.openingTotal).toBe('0.00');
  expect(eq.closingTotal).toBe('0.00');
  expect(eq.result.movement).toBe('0.00');
  expect(eq.balanced).toBe(true);
});

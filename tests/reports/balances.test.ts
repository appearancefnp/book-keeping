import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { accountBalances } from '../../src/ledger/balances.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seed() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 2 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    // Feb sale: DR bank 100 / CR sales 100
    await postEntry(tx, ctx(t), {
      date: '2026-02-15', memo: 'Feb sale', currency: 'EUR',
      lines: [
        { accountCode: '2620', debit: '100.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '100.00' },
      ],
    });
    // Mar sale: DR bank 50 / CR sales 50
    await postEntry(tx, ctx(t), {
      date: '2026-03-15', memo: 'Mar sale', currency: 'EUR',
      lines: [
        { accountCode: '2620', debit: '50.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '50.00' },
      ],
    });
  });
  return t;
}

test('accountBalances with no range sums everything (== trial balance)', async () => {
  const t = await seed();
  const rows = await withTenant(ctx(t), (tx) => accountBalances(tx, ctx(t), {}));
  const bank = rows.find((r) => r.code === '2620')!;
  const sales = rows.find((r) => r.code === '6110')!;
  expect(bank.balance).toBe('150.00');   // 150 debit
  expect(sales.balance).toBe('-150.00'); // 150 credit → debit-normal negative
  expect(bank.type).toBe('asset');
  expect(sales.type).toBe('income');
});

test('accountBalances filters by entry_date range (inclusive)', async () => {
  const t = await seed();
  const rows = await withTenant(ctx(t), (tx) =>
    accountBalances(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  const bank = rows.find((r) => r.code === '2620')!;
  expect(bank.balance).toBe('50.00'); // only the March entry
});

test('accountBalances includes zero-balance accounts', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => createAccount(tx, ctx(t), { code: '1000', name: 'Idle', type: 'asset' }));
  const rows = await withTenant(ctx(t), (tx) => accountBalances(tx, ctx(t), {}));
  expect(rows.find((r) => r.code === '1000')!.balance).toBe('0.00');
});

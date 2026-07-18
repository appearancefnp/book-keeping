import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { listAccountLines } from '../../src/ledger/query.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seed() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 4 });
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale A', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '300.00', credit: '0', description: 'in' },
      { accountCode: '6110', debit: '0', credit: '300.00', description: 'rev' },
    ]});
    await postEntry(tx, ctx(t), { date: '2026-04-05', memo: 'Sale B', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '50.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '50.00' },
    ]});
  });
  return t;
}

test('lists lines in a date range, ordered by account code then date', async () => {
  const t = await seed();
  const rows = await withTenant(ctx(t), (tx) => listAccountLines(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(rows).toHaveLength(2); // only the March entry's two lines
  expect(rows.map((r) => r.accountCode)).toEqual(['2620', '6110']);
  expect(rows[0]).toMatchObject({ accountCode: '2620', debit: '300.00', credit: '0.00', memo: 'Sale A', description: 'in' });
  expect(rows[0]!.entryDate).toBe('2026-03-10');
});

test('filters by accountCodes', async () => {
  const t = await seed();
  const rows = await withTenant(ctx(t), (tx) => listAccountLines(tx, ctx(t), { from: '2026-01-01', to: '2026-12-31', accountCodes: ['6110'] }));
  expect(rows).toHaveLength(2); // both Sales lines across March + April
  expect(new Set(rows.map((r) => r.accountCode))).toEqual(new Set(['6110']));
});

test('empty accountCodes array is treated as no filter', async () => {
  const t = await seed();
  const rows = await withTenant(ctx(t), (tx) => listAccountLines(tx, ctx(t), { from: '2026-01-01', to: '2026-12-31', accountCodes: [] }));
  expect(rows.length).toBe(4);
});

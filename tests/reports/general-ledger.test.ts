import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { generalLedger } from '../../src/reports/general-ledger.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seed() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    for (const m of [2, 3, 4]) await openPeriod(tx, ctx(t), { year: 2026, month: m });
    // February (before range): DR bank 100 / CR sales 100
    await postEntry(tx, ctx(t), { date: '2026-02-20', memo: 'Prior', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '100.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
    ]});
    // March (in range): two bank movements
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '300.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '300.00' },
    ]});
    await postEntry(tx, ctx(t), { date: '2026-03-15', memo: 'Refund', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '0', credit: '50.00' },
      { accountCode: '6110', debit: '50.00', credit: '0' },
    ]});
  });
  return t;
}

test('generalLedger computes opening, running, and closing per account', async () => {
  const t = await seed();
  const gl = await withTenant(ctx(t), (tx) => generalLedger(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  const bank = gl.accounts.find((a) => a.code === '2620')!;
  expect(bank.opening).toBe('100.00');            // Feb debit-normal 100
  expect(bank.lines.map((l) => l.balance)).toEqual(['400.00', '350.00']); // +300 then -50
  expect(bank.closing).toBe('350.00');
  expect(bank.totalDebit).toBe('300.00');
  expect(bank.totalCredit).toBe('50.00');
  // accounts ordered by code
  expect(gl.accounts.map((a) => a.code)).toEqual(['2620', '6110']);
});

test('single-account filter returns only that account (drill-down)', async () => {
  const t = await seed();
  const gl = await withTenant(ctx(t), (tx) => generalLedger(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31', accountCodes: ['6110'] }));
  expect(gl.accounts).toHaveLength(1);
  expect(gl.accounts[0]!.code).toBe('6110');
  expect(gl.accounts[0]!.opening).toBe('-100.00'); // Feb credit-normal → debit-normal -100
  expect(gl.accounts[0]!.closing).toBe('-350.00'); // -100 -300 +50
});

test('a filtered account with no activity shows opening=closing, no lines', async () => {
  const t = await seed();
  const gl = await withTenant(ctx(t), (tx) => generalLedger(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31', accountCodes: ['2620'] }));
  const acct = gl.accounts[0]!;
  // sanity: has lines here; instead check an empty window
  const empty = await withTenant(ctx(t), (tx) => generalLedger(tx, ctx(t), { from: '2026-05-01', to: '2026-05-31', accountCodes: ['2620'] }));
  expect(empty.accounts[0]!.lines).toHaveLength(0);
  expect(empty.accounts[0]!.opening).toBe(empty.accounts[0]!.closing);
  expect(acct.lines.length).toBeGreaterThan(0);
});

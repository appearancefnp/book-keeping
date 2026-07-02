import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { trialBalance } from '../../src/ledger/balances.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('trial balance aggregates debits and credits per account and totals net to zero', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), {
      date: '2026-03-10', memo: 'Sale', currency: 'EUR',
      lines: [
        { accountCode: '2310', debit: '121.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '121.00' },
      ],
    });
  });

  const tb = await withTenant(ctx(t), (tx) => trialBalance(tx, ctx(t)));
  const bank = tb.find((r) => r.code === '2310')!;
  const sales = tb.find((r) => r.code === '6110')!;
  expect(bank.debit).toBe('121.00');
  expect(sales.credit).toBe('121.00');
  const totalDebit = tb.reduce((a, r) => a + Number(r.debit), 0);
  const totalCredit = tb.reduce((a, r) => a + Number(r.credit), 0);
  expect(totalDebit).toBe(totalCredit);
});

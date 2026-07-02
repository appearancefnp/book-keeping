import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry, reverseEntry, getEntry } from '../../src/ledger/posting.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('reversing an entry swaps debits and credits', async () => {
  const t = await makeFirmAndClient();
  const original = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return postEntry(tx, ctx(t), {
      date: '2026-03-10', memo: 'Sale', currency: 'EUR',
      lines: [
        { accountCode: '2310', debit: '121.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '121.00' },
      ],
    });
  });

  const reversal = await withTenant(ctx(t), (tx) =>
    reverseEntry(tx, ctx(t), original.entryId, 'Reverse sale'));

  const rev = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), reversal.entryId));
  // Line that was a 121.00 debit is now a 121.00 credit.
  const debitLine = rev.lines.find((l) => l.credit === '121.00');
  expect(debitLine).toBeDefined();
  expect(rev.lines.every((l) => (l.debit === '0.00') !== (l.credit === '0.00'))).toBe(true);
});

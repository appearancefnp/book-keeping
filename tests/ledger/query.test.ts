import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { listJournalEntries } from '../../src/ledger/query.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('lists posted entries newest-first with account-coded lines', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2600', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), {
      date: '2026-03-01', memo: 'First', currency: 'EUR',
      lines: [
        { accountCode: '2600', debit: '100.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '100.00' },
      ],
    });
    await postEntry(tx, ctx(t), {
      date: '2026-03-15', memo: 'Second', currency: 'EUR',
      lines: [
        { accountCode: '2600', debit: '50.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '50.00' },
      ],
    });
  });
  const entries = await withTenant(ctx(t), (tx) => listJournalEntries(tx, ctx(t)));
  expect(entries).toHaveLength(2);
  expect(entries[0]!.memo).toBe('Second');
  expect(entries[0]!.entryDate).toBe('2026-03-15');
  expect(entries[0]!.lines).toHaveLength(2);
  const bankLine = entries[0]!.lines.find((l) => l.accountCode === '2600')!;
  expect(bankLine.debit).toBe('50.00');
  expect(bankLine.accountName).toBe('Bank');
});

test('limit applies to entries, not lines; tenant-scoped', async () => {
  const t = await makeFirmAndClient();
  const t2 = await makeFirmAndClient('SIA Cits');
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2600', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    for (const d of ['2026-03-01', '2026-03-02', '2026-03-03']) {
      await postEntry(tx, ctx(t), {
        date: d, memo: `E ${d}`, currency: 'EUR',
        lines: [
          { accountCode: '2600', debit: '10.00', credit: '0' },
          { accountCode: '6110', debit: '0', credit: '10.00' },
        ],
      });
    }
  });
  const limited = await withTenant(ctx(t), (tx) => listJournalEntries(tx, ctx(t), { limit: 2 }));
  expect(limited).toHaveLength(2);
  expect(limited.every((e) => e.lines.length === 2)).toBe(true);
  const other = await withTenant(ctx(t2), (tx) => listJournalEntries(tx, ctx(t2)));
  expect(other).toHaveLength(0);
});

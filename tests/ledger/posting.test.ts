import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod, closePeriod } from '../../src/ledger/periods.js';
import { postEntry, getEntry } from '../../src/ledger/posting.js';

async function seed(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
  });
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('posts a balanced two-line entry and reads it back', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const { entryId } = await withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), {
    date: '2026-03-10', memo: 'Sale', currency: 'EUR',
    lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '121.00' },
    ],
  }));
  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), entryId));
  expect(entry.lines).toHaveLength(2);
  expect(entry.memo).toBe('Sale');
});

test('rejects an unbalanced entry', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await expect(withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), {
    date: '2026-03-10', memo: 'Bad', currency: 'EUR',
    lines: [
      { accountCode: '2310', debit: '100.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '90.00' },
    ],
  }))).rejects.toThrow(/balance/i);
});

test('rejects posting into a closed period', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), (tx) => closePeriod(tx, ctx(t), { year: 2026, month: 3 }));
  await expect(withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), {
    date: '2026-03-10', memo: 'Late', currency: 'EUR',
    lines: [
      { accountCode: '2310', debit: '10.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '10.00' },
    ],
  }))).rejects.toThrow(/closed|period/i);
});

test('journal is append-only: UPDATE on journal_entries is blocked', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const { entryId } = await withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), {
    date: '2026-03-10', memo: 'Sale', currency: 'EUR',
    lines: [
      { accountCode: '2310', debit: '5.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '5.00' },
    ],
  }));
  await expect(withTenant(ctx(t), (tx) =>
    tx.query("UPDATE journal_entries SET memo = 'x' WHERE id = $1", [entryId]),
  )).rejects.toThrow(/append-only/i);
});

test('writes an audit row when an entry is posted', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const audits = await withTenant(ctx(t), async (tx) => {
    await postEntry(tx, ctx(t), {
      date: '2026-03-10', memo: 'Sale', currency: 'EUR',
      lines: [
        { accountCode: '2310', debit: '5.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '5.00' },
      ],
    });
    const r = await tx.query("SELECT action, entity_type FROM audit_log WHERE entity_type = 'journal_entry'");
    return r.rows;
  });
  expect(audits).toHaveLength(1);
  expect(audits[0].action).toBe('post');
});

import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { randomUUID } from 'node:crypto';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { StubBankFeedProvider } from '../../src/bankfeed/stub.js';
import { createConnection, finalizeConnection, getConnection } from '../../src/bankfeed/connections.js';
import { syncConnection, isoAddDays, FIRST_SYNC_DAYS, OVERLAP_DAYS } from '../../src/bankfeed/sync.js';
import type { FeedTxn } from '../../src/bankfeed/provider.js';

const TODAY = '2026-07-19';

function txn(over: Partial<FeedTxn>): FeedTxn {
  return { bookingDate: '2026-07-10', amount: '121.00', currency: 'EUR', reference: 'INV-1',
    counterparty: 'SIA Klients', endToEndId: 'INV-2026-001', providerTxId: 'gc-1', ...over };
}

async function linkedConnection(t: { firmId: string; clientCompanyId: string }, p: StubBankFeedProvider,
  accounts = [{ providerAccountId: 'acc-1', iban: 'LV11TEST0000000000001', currency: 'EUR' }]) {
  const connectionId = randomUUID();
  await withTenant(ctx(t), (tx) =>
    createConnection(tx, ctx(t), p, { connectionId, institutionId: 'STUB_BANK', institutionName: 'Stub', redirectUrl: 'http://x' }));
  p.linkRequisition('stub-req-1', accounts, '2026-10-01T00:00:00Z');
  await withTenant(ctx(t), (tx) => finalizeConnection(tx, ctx(t), p, connectionId));
  return connectionId;
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('isoAddDays', () => {
  expect(isoAddDays('2026-07-19', -7)).toBe('2026-07-12');
  expect(isoAddDays('2026-01-01', -1)).toBe('2025-12-31');
});

test('first sync imports the 90-day window and advances the cursor', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const id = await linkedConnection(t, p);
  p.transactionsByAccount.set('acc-1', [
    txn({}),
    txn({ bookingDate: isoAddDays(TODAY, -FIRST_SYNC_DAYS - 1), providerTxId: 'too-old', endToEndId: 'too-old' }),
  ]);
  const r = await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, TODAY));
  expect(r.status).toBe('linked');
  expect(r.accounts[0]!.imported).toBe(1); // the too-old txn is outside the window
  const conn = await withTenant(ctx(t), (tx) => getConnection(tx, ctx(t), id));
  expect(conn.accounts[0]!.lastSyncedDate).toBe(TODAY);
});

test('re-sync with overlap imports nothing new', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const id = await linkedConnection(t, p);
  p.transactionsByAccount.set('acc-1', [txn({})]);
  await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, '2026-07-12'));
  // next-day sync re-fetches from 2026-07-05 (cursor − OVERLAP_DAYS) and dedups
  const again = await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, '2026-07-13'));
  expect(again.accounts[0]!.imported).toBe(0);
  expect(again.accounts[0]!.skipped).toBe(1);
  const n = await withTenant(ctx(t), async (tx) => (await tx.query('SELECT count(*)::int AS n FROM bank_transactions')).rows[0].n);
  expect(n).toBe(1);
});

test('feed transactions produce match proposals (credit → receivable)', async () => {
  // Mirror tests/banking/match.test.ts: post a 121.00 receivable on 2310, then sync a 121.00 credit.
  // Copy the ledger-seeding helper from that file verbatim.
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const id = await linkedConnection(t, p);
  p.transactionsByAccount.set('acc-1', [txn({ amount: '121.00' })]);
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 7 });
    // Credit sale creating a 121.00 receivable
    await postEntry(tx, ctx(t), { date: '2026-07-05', memo: 'Credit sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '121.00' },
    ]});
  });
  const r = await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, TODAY));
  expect(r.proposals).toBeGreaterThanOrEqual(1);
});

test('expired consent flips status and imports nothing', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const id = await linkedConnection(t, p);
  p.setStatus('stub-req-1', 'expired');
  const r = await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, TODAY));
  expect(r.status).toBe('expired');
  expect(r.accounts).toHaveLength(0);
  const conn = await withTenant(ctx(t), (tx) => getConnection(tx, ctx(t), id));
  expect(conn.status).toBe('expired');
});

test('per-account failure records last_error, sibling account still imports, success clears', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const id = await linkedConnection(t, p, [
    { providerAccountId: 'acc-1', iban: 'LV11TEST0000000000001', currency: 'EUR' },
    { providerAccountId: 'acc-2', iban: 'LV22TEST0000000000002', currency: 'EUR' },
  ]);
  p.transactionsByAccount.set('acc-2', [txn({ providerTxId: 'x2', endToEndId: '' })]);
  p.fetchErrors.set('acc-1', 'rate limited');
  const r = await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, TODAY));
  const byIban = Object.fromEntries(r.accounts.map((a) => [a.iban, a]));
  expect(byIban['LV11TEST0000000000001']!.error).toMatch(/rate limited/);
  expect(byIban['LV22TEST0000000000002']!.imported).toBe(1);
  let conn = await withTenant(ctx(t), (tx) => getConnection(tx, ctx(t), id));
  expect(conn.lastError).toMatch(/rate limited/);
  // failed account's cursor did NOT advance; successful one did
  const cursors = Object.fromEntries(conn.accounts.map((a) => [a.iban, a.lastSyncedDate]));
  expect(cursors['LV11TEST0000000000001']).toBeNull();
  expect(cursors['LV22TEST0000000000002']).toBe(TODAY);

  p.fetchErrors.delete('acc-1');
  await withTenant(ctx(t), (tx) => syncConnection(tx, ctx(t), p, id, TODAY));
  conn = await withTenant(ctx(t), (tx) => getConnection(tx, ctx(t), id));
  expect(conn.lastError).toBe('');
});

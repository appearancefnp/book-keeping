import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { importStatement } from '../../src/banking/import.js';
import { proposeMatches } from '../../src/banking/match.js';
import { rejectProposal } from '../../src/proposals/lifecycle.js';

const config = { receivablesAccount: '2310', bankAccount: '2620' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setupAndPropose(t: { firmId: string; clientCompanyId: string }) {
  return withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Credit sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '121.00' },
    ]});
    await importStatement(tx, ctx(t), { account: 'LV80', transactions: [
      { bookingDate: '2026-03-10', amountCents: '12100', currency: 'EUR', side: 'credit', reference: 'pmt', counterparty: 'SIA Klients', endToEndId: 'E1' },
    ]});
    return (await proposeMatches(tx, ctx(t), config)).proposalIds;
  });
}

async function txnStatus(t: { firmId: string; clientCompanyId: string }): Promise<string> {
  const r = await withTenant(ctx(t), (tx) =>
    tx.query(`SELECT status FROM bank_transactions WHERE client_company_id = $1`, [t.clientCompanyId]));
  return r.rows[0].status as string;
}

test('rejecting a bank_match reverts the transaction to unmatched and allows re-proposing', async () => {
  const t = await makeFirmAndClient();
  const ids = await setupAndPropose(t);
  expect(ids).toHaveLength(1);
  expect(await txnStatus(t)).toBe('matched');

  await withTenant(ctx(t), (tx) => rejectProposal(tx, ctx(t), ids[0]!, 'wrong candidate'));
  expect(await txnStatus(t)).toBe('unmatched');

  // The freed transaction is picked up again on the next propose run.
  const again = await withTenant(ctx(t), (tx) => proposeMatches(tx, ctx(t), config));
  expect(again.proposalIds).toHaveLength(1);
});

test('rejecting a non-bank_match proposal touches no bank transaction', async () => {
  const t = await makeFirmAndClient();
  const ids = await setupAndPropose(t);
  expect(await txnStatus(t)).toBe('matched');
  // Reject an unrelated task proposal — the matched transaction must stay matched.
  const { createProposal } = await import('../../src/proposals/proposals.js');
  const { id } = await withTenant(ctx(t), (tx) =>
    createProposal(tx, ctx(t), { type: 'task', payload: {}, rationale: {}, status: 'pending_approval' }));
  await withTenant(ctx(t), (tx) => rejectProposal(tx, ctx(t), id, 'no'));
  expect(await txnStatus(t)).toBe('matched');
  expect(ids).toHaveLength(1);
});

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry, getEntry } from '../../src/ledger/posting.js';
import { importStatement } from '../../src/banking/import.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { createProposal, getProposal } from '../../src/proposals/proposals.js';
import { postApprovedBankMatch } from '../../src/banking/confirm-match.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('approving + confirming a match posts a settlement and reconciles the txn', async () => {
  const t = await makeFirmAndClient();
  const { proposalId, txnId } = await withTenant(ctx(t), async (tx) => {
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
    const txnId = (await tx.query('SELECT id FROM bank_transactions LIMIT 1')).rows[0].id as string;
    const { id: pid } = await createProposal(tx, ctx(t), {
      type: 'bank_match',
      payload: { bankTransactionId: txnId, amountCents: '12100', bankAccount: '2620', receivablesAccount: '2310' },
      rationale: { ruleRef: 'bank-match-amount' },
      status: 'pending_approval',
    });
    await tx.query(`UPDATE bank_transactions SET status='matched' WHERE id=$1 AND client_company_id=$2`, [txnId, ctx(t).clientCompanyId]);
    await approveProposal(tx, ctx(t), pid);
    const { entryId } = await postApprovedBankMatch(tx, ctx(t), pid);
    const p = await getProposal(tx, ctx(t), pid);
    const txn = (await tx.query('SELECT status, matched_entry_id FROM bank_transactions LIMIT 1')).rows[0];
    return { proposalId: pid, txnId: entryId, _p: p, _txn: txn, entry: await getEntry(tx, ctx(t), entryId) };
  });
  // Re-read for assertions
  const [entry, prop, txn] = await withTenant(ctx(t), async (tx) => [
    await getEntry(tx, ctx(t), txnId),
    await getProposal(tx, ctx(t), proposalId),
    (await tx.query('SELECT status, matched_entry_id AS "matchedEntryId" FROM bank_transactions LIMIT 1')).rows[0],
  ]);
  // Settlement: DR bank 121 / CR receivable 121
  expect(entry.lines).toHaveLength(2);
  expect(prop.status).toBe('posted');
  expect(prop.resolvedEntryId).toBe(txnId);
  expect(txn.status).toBe('reconciled');
  expect(txn.matchedEntryId).toBe(txnId);
});

test('refuses to confirm a match that is not approved', async () => {
  const t = await makeFirmAndClient();
  await expect(withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '121.00' },
    ]});
    await importStatement(tx, ctx(t), { account: 'LV80', transactions: [
      { bookingDate: '2026-03-10', amountCents: '12100', currency: 'EUR', side: 'credit', reference: 'p', counterparty: 'c', endToEndId: 'E1' },
    ]});
    const txnId = (await tx.query('SELECT id FROM bank_transactions LIMIT 1')).rows[0].id as string;
    const { id: pid } = await createProposal(tx, ctx(t), {
      type: 'bank_match',
      payload: { bankTransactionId: txnId, amountCents: '12100', bankAccount: '2620', receivablesAccount: '2310' },
      rationale: { ruleRef: 'bank-match-amount' },
      status: 'pending_approval',
    });
    await tx.query(`UPDATE bank_transactions SET status='matched' WHERE id=$1 AND client_company_id=$2`, [txnId, ctx(t).clientCompanyId]);
    return postApprovedBankMatch(tx, ctx(t), pid); // not approved
  })).rejects.toThrow(/approved/i);
});

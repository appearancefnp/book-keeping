import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { importStatement } from '../../src/banking/import.js';
import { proposeExpenseMatches } from '../../src/banking/match.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { rejectProposal, approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedBankMatch } from '../../src/banking/confirm-match.js';
import { saveClaim, getClaim } from '../../src/expenses/claims.js';
import { submitClaim } from '../../src/expenses/submit.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { listJournalEntries } from '../../src/ledger/query.js';
import { setup, type Fixture } from './helpers.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const CONFIG = { bankAccount: '2620', settlementAccount: '5610' };
const POST_ACCOUNTS = { settlementAccount: '5610', vatInputAccount: '5722' };

const RECEIPT_DEDUCTIBLE = {
  kind: 'receipt' as const, lineDate: '2026-07-01', description: 'Hotel', expenseAccount: '7550',
  net: '10.00', vat: '2.10', vatDeductible: true,
}; // gross total 12.10 -> 1210 cents

async function setupAccounts(f: Fixture): Promise<void> {
  await withTenant(f.accountantCtx, async (tx) => {
    await createAccount(tx, f.accountantCtx, { code: '7550', name: 'Travel & subsistence', type: 'expense' });
    await createAccount(tx, f.accountantCtx, { code: '5722', name: 'VAT input (expenses)', type: 'asset' });
    await createAccount(tx, f.accountantCtx, { code: '5610', name: 'Employee settlements', type: 'liability' });
    await createAccount(tx, f.accountantCtx, { code: '2620', name: 'Bank', type: 'asset' });
    await openPeriod(tx, f.accountantCtx, { year: 2026, month: 7 });
  });
}

/** Drive employeeId's claim from draft through approved (submit -> approve -> post). */
async function approveClaim(f: Fixture, employeeId: string, description: string): Promise<string> {
  const { claimId, proposalId } = await withTenant(f.accountantCtx, async (tx) => {
    const { claimId } = await saveClaim(tx, f.accountantCtx, {
      employeeId, description, lines: [RECEIPT_DEDUCTIBLE],
    });
    const { proposalId } = await submitClaim(tx, f.accountantCtx, claimId, POST_ACCOUNTS);
    return { claimId, proposalId };
  });
  await withTenant(f.accountantCtx, async (tx) => {
    await approveProposal(tx, f.accountantCtx, proposalId);
    await postApprovedPosting(tx, f.accountantCtx, proposalId);
  });
  return claimId;
}

async function importDebit(f: Fixture, amountCents: string, endToEndId: string): Promise<void> {
  await withTenant(f.accountantCtx, (tx) => importStatement(tx, f.accountantCtx, {
    account: 'LV80',
    transactions: [
      { bookingDate: '2026-07-15', amountCents, currency: 'EUR', side: 'debit', reference: 'Reimb', counterparty: 'Anna Ozola', endToEndId },
    ],
  }));
}

async function txnStatuses(f: Fixture): Promise<string[]> {
  const r = await withTenant(f.accountantCtx, (tx) =>
    tx.query(`SELECT status FROM bank_transactions WHERE client_company_id = $1 ORDER BY id`, [f.clientCompanyId]));
  return r.rows.map((row) => row.status as string);
}

test('a debit equal to one approved claim proposes an expense_direct match', async () => {
  const f = await setup();
  await setupAccounts(f);
  const claimId = await approveClaim(f, f.employeeAId, 'July expenses');
  await importDebit(f, '1210', 'e2e-1');

  const { proposalIds } = await withTenant(f.accountantCtx, (tx) => proposeExpenseMatches(tx, f.accountantCtx, CONFIG));
  expect(proposalIds).toHaveLength(1);
  expect(await txnStatuses(f)).toEqual(['matched']);

  const prop = await withTenant(f.accountantCtx, (tx) => getProposal(tx, f.accountantCtx, proposalIds[0]!));
  expect(prop.type).toBe('bank_match');
  expect(prop.payload).toMatchObject({ kind: 'expense_direct', claimId, amountCents: '1210' });
  expect((prop.payload as { bankTransactionId: string }).bankTransactionId).toBeTruthy();
});

test('no proposal for a draft (not-yet-approved) claim even when the debit amount matches', async () => {
  const f = await setup();
  await setupAccounts(f);

  // Claim exists but is still a draft — must not match.
  await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeAId, description: 'Draft claim', lines: [RECEIPT_DEDUCTIBLE],
  }));
  await importDebit(f, '1210', 'e2e-1');
  const draftAttempt = await withTenant(f.accountantCtx, (tx) => proposeExpenseMatches(tx, f.accountantCtx, CONFIG));
  expect(draftAttempt.proposalIds).toHaveLength(0);
  expect(await txnStatuses(f)).toEqual(['unmatched']);
});

test('no proposal when the debit amount differs from the approved claim total', async () => {
  const f = await setup();
  await setupAccounts(f);

  // Approved claim exists (total 1210), but the debit amount differs — must not match.
  await approveClaim(f, f.employeeBId, 'July expenses B');
  await importDebit(f, '999', 'e2e-2');
  const mismatchAttempt = await withTenant(f.accountantCtx, (tx) => proposeExpenseMatches(tx, f.accountantCtx, CONFIG));
  expect(mismatchAttempt.proposalIds).toHaveLength(0);
  expect(await txnStatuses(f)).toEqual(['unmatched']);
});

test('two equal debits cannot both claim one claim (propose-time dedup)', async () => {
  const f = await setup();
  await setupAccounts(f);
  await approveClaim(f, f.employeeAId, 'July expenses');
  await importDebit(f, '1210', 'e2e-1');
  await importDebit(f, '1210', 'e2e-2');

  const { proposalIds } = await withTenant(f.accountantCtx, (tx) => proposeExpenseMatches(tx, f.accountantCtx, CONFIG));
  expect(proposalIds).toHaveLength(1);
  // One transaction stays matched (claimed the proposal), the other remains unmatched.
  const statuses = await txnStatuses(f);
  expect(statuses.filter((s) => s === 'matched')).toHaveLength(1);
  expect(statuses.filter((s) => s === 'unmatched')).toHaveLength(1);
});

test('confirming an approved expense_direct match settles the claim and reconciles the txn', async () => {
  const f = await setup();
  await setupAccounts(f);
  const claimId = await approveClaim(f, f.employeeAId, 'July expenses');
  await importDebit(f, '1210', 'e2e-1');
  const { proposalIds } = await withTenant(f.accountantCtx, (tx) => proposeExpenseMatches(tx, f.accountantCtx, CONFIG));
  const proposalId = proposalIds[0]!;

  await withTenant(f.accountantCtx, (tx) => approveProposal(tx, f.accountantCtx, proposalId));
  const { entryId } = await withTenant(f.accountantCtx, (tx) => postApprovedBankMatch(tx, f.accountantCtx, proposalId));
  expect(entryId).toBeTruthy();

  const claim = await withTenant(f.accountantCtx, (tx) => getClaim(tx, f.accountantCtx, claimId));
  expect(claim.status).toBe('reimbursed');

  const entries = await withTenant(f.accountantCtx, (tx) => listJournalEntries(tx, f.accountantCtx, {}));
  const entry = entries.find((e) => e.id === entryId)!;
  expect(entry.lines.find((l) => l.accountCode === '5610')!.debit).toBe('12.10');
  expect(entry.lines.find((l) => l.accountCode === '2620')!.credit).toBe('12.10');

  const txnRow = await withTenant(f.accountantCtx, (tx) =>
    tx.query(`SELECT status, matched_entry_id AS "matchedEntryId" FROM bank_transactions WHERE client_company_id = $1`, [f.clientCompanyId]));
  expect(txnRow.rows[0].status).toBe('reconciled');
  expect(txnRow.rows[0].matchedEntryId).toBe(entryId);
});

test('rejecting an expense_direct match frees the bank transaction (generic reject path)', async () => {
  const f = await setup();
  await setupAccounts(f);
  await approveClaim(f, f.employeeAId, 'July expenses');
  await importDebit(f, '1210', 'e2e-1');
  const { proposalIds } = await withTenant(f.accountantCtx, (tx) => proposeExpenseMatches(tx, f.accountantCtx, CONFIG));
  expect(proposalIds).toHaveLength(1);
  expect(await txnStatuses(f)).toEqual(['matched']);

  await withTenant(f.accountantCtx, (tx) => rejectProposal(tx, f.accountantCtx, proposalIds[0]!, 'wrong candidate'));
  expect(await txnStatuses(f)).toEqual(['unmatched']);

  // The freed transaction is picked up again on the next propose run.
  const again = await withTenant(f.accountantCtx, (tx) => proposeExpenseMatches(tx, f.accountantCtx, CONFIG));
  expect(again.proposalIds).toHaveLength(1);
});

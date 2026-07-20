import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { importStatement } from '../../src/banking/import.js';
import { listJournalEntries } from '../../src/ledger/query.js';
import { setup, type Fixture } from './helpers.js';
import { saveClaim, getClaim } from '../../src/expenses/claims.js';
import { submitClaim } from '../../src/expenses/submit.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { settleClaim, buildReimbursementOrder } from '../../src/expenses/reimburse.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const ACCOUNTS = { settlementAccount: '5610', vatInputAccount: '5722' };

const RECEIPT_DEDUCTIBLE = {
  kind: 'receipt' as const, lineDate: '2026-07-01', description: 'Hotel', expenseAccount: '7550',
  net: '10.00', vat: '2.10', vatDeductible: true,
}; // gross total 12.10

/** Shared chart of accounts + open period for the reimbursement flow. */
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
    const { proposalId } = await submitClaim(tx, f.accountantCtx, claimId, ACCOUNTS);
    return { claimId, proposalId };
  });
  await withTenant(f.accountantCtx, async (tx) => {
    await approveProposal(tx, f.accountantCtx, proposalId);
    await postApprovedPosting(tx, f.accountantCtx, proposalId);
  });
  return claimId;
}

async function setIban(f: Fixture, employeeId: string, iban: string): Promise<void> {
  await withTenant(f.accountantCtx, (tx) => tx.query(`UPDATE employees SET iban = $1 WHERE id = $2`, [iban, employeeId]));
}

test('settleClaim posts DR 5610 / CR 2620 for the gross total and flips approved→reimbursed', async () => {
  const f = await setup();
  await setupAccounts(f);
  const claimId = await approveClaim(f, f.employeeAId, 'July expenses');

  const { entryId } = await withTenant(f.accountantCtx, (tx) => settleClaim(tx, f.accountantCtx, {
    claimId, paidDate: '2026-07-15', method: 'manual', bankAccount: '2620', settlementAccount: '5610',
  }));
  expect(entryId).toBeTruthy();

  const claim = await withTenant(f.accountantCtx, (tx) => getClaim(tx, f.accountantCtx, claimId));
  expect(claim.status).toBe('reimbursed');

  const entries = await withTenant(f.accountantCtx, (tx) => listJournalEntries(tx, f.accountantCtx, {}));
  const entry = entries.find((e) => e.id === entryId)!;
  expect(entry.lines.find((l) => l.accountCode === '5610')!.debit).toBe('12.10');
  expect(entry.lines.find((l) => l.accountCode === '2620')!.credit).toBe('12.10');

  const raw = await withTenant(f.accountantCtx, (tx) => tx.query(
    `SELECT reimbursement_entry_id AS "entryId", reimbursed_at AS "reimbursedAt" FROM expense_claims WHERE id = $1`, [claimId],
  ));
  expect(raw.rows[0].entryId).toBe(entryId);
  expect(raw.rows[0].reimbursedAt).toBeTruthy();
});

test('settleClaim refuses non-approved claims and double settlement', async () => {
  const f = await setup();
  await setupAccounts(f);

  // Still a draft (never submitted/approved).
  const { claimId: draftId } = await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeAId, description: 'Draft', lines: [RECEIPT_DEDUCTIBLE],
  }));
  await expect(withTenant(f.accountantCtx, (tx) => settleClaim(tx, f.accountantCtx, {
    claimId: draftId, paidDate: '2026-07-15', method: 'manual', bankAccount: '2620', settlementAccount: '5610',
  }))).rejects.toThrow(/not settleable/);

  // Approved, then settled once — a second settlement attempt must also fail.
  const claimId = await approveClaim(f, f.employeeAId, 'July expenses');
  await withTenant(f.accountantCtx, (tx) => settleClaim(tx, f.accountantCtx, {
    claimId, paidDate: '2026-07-15', method: 'manual', bankAccount: '2620', settlementAccount: '5610',
  }));
  await expect(withTenant(f.accountantCtx, (tx) => settleClaim(tx, f.accountantCtx, {
    claimId, paidDate: '2026-07-16', method: 'manual', bankAccount: '2620', settlementAccount: '5610',
  }))).rejects.toThrow(/not settleable/);
});

test('a bank transaction may settle at most one claim (dedup guard)', async () => {
  const f = await setup();
  await setupAccounts(f);
  const claimAId = await approveClaim(f, f.employeeAId, 'July expenses A');
  const claimBId = await approveClaim(f, f.employeeBId, 'July expenses B');

  const bankTxnId = await withTenant(f.accountantCtx, async (tx) => {
    await importStatement(tx, f.accountantCtx, {
      account: 'LV80',
      transactions: [
        { bookingDate: '2026-07-15', amountCents: '1210', currency: 'EUR', side: 'debit', reference: 'Reimb', counterparty: 'Anna Ozola', endToEndId: 'e2e-1' },
      ],
    });
    const res = await tx.query(`SELECT id FROM bank_transactions LIMIT 1`);
    return res.rows[0].id as string;
  });

  await withTenant(f.accountantCtx, (tx) => settleClaim(tx, f.accountantCtx, {
    claimId: claimAId, paidDate: '2026-07-15', method: 'bank_match', bankTransactionId: bankTxnId, bankAccount: '2620', settlementAccount: '5610',
  }));

  await expect(withTenant(f.accountantCtx, (tx) => settleClaim(tx, f.accountantCtx, {
    claimId: claimBId, paidDate: '2026-07-15', method: 'bank_match', bankTransactionId: bankTxnId, bankAccount: '2620', settlementAccount: '5610',
  }))).rejects.toThrow(/already settled by bank transaction/);
});

test('buildReimbursementOrder emits pain.001 with the employee IBAN, amount, claim reference', async () => {
  const f = await setup();
  await setupAccounts(f);
  await setIban(f, f.employeeAId, 'LV80BANK0000435195001');
  const claimId = await approveClaim(f, f.employeeAId, 'July expenses');

  const { xml, total } = await withTenant(f.accountantCtx, (tx) => buildReimbursementOrder(tx, f.accountantCtx, [claimId]));

  expect(total).toBe('12.10');
  expect(xml).toContain('<IBAN>LV80BANK0000435195001</IBAN>');
  expect(xml).toContain('<InstdAmt Ccy="EUR">12.10</InstdAmt>');
  expect(xml).toContain(claimId.slice(0, 8));
  expect(xml).toContain('July expenses');
});

test('buildReimbursementOrder throws a clear error when an employee lacks an IBAN', async () => {
  const f = await setup();
  await setupAccounts(f);
  const claimId = await approveClaim(f, f.employeeBId, 'July expenses B'); // no IBAN set for employee B

  await expect(withTenant(f.accountantCtx, (tx) => buildReimbursementOrder(tx, f.accountantCtx, [claimId])))
    .rejects.toThrow(/Baiba Kalna/);
});

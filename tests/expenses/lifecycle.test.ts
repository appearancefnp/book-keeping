import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { setup } from './helpers.js';
import { saveClaim, getClaim } from '../../src/expenses/claims.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { approveProposal, rejectProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { listJournalEntries } from '../../src/ledger/query.js';
import { submitClaim } from '../../src/expenses/submit.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const ACCOUNTS = { settlementAccount: '5610', vatInputAccount: '5722' };

const RECEIPT_DEDUCTIBLE = {
  kind: 'receipt' as const, lineDate: '2026-07-01', description: 'Hotel', expenseAccount: '7550',
  net: '10.00', vat: '2.10', vatDeductible: true,
};
const RECEIPT_NONDEDUCTIBLE = {
  kind: 'receipt' as const, lineDate: '2026-07-02', description: 'Client dinner', expenseAccount: '7550',
  net: '5.00', vat: '1.05', vatDeductible: false,
};
const MILEAGE = {
  kind: 'mileage' as const, lineDate: '2026-07-03', description: 'Site visit', expenseAccount: '7570', km: '12.5',
};

test('submitClaim flips draft->submitted and creates a pending posting proposal with entry payload + rationale', async () => {
  const f = await setup();
  const { claimId } = await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeAId, description: 'July expenses', lines: [RECEIPT_DEDUCTIBLE],
  }));

  const { proposalId } = await withTenant(f.accountantCtx, (tx) => submitClaim(tx, f.accountantCtx, claimId, ACCOUNTS));

  const claim = await withTenant(f.accountantCtx, (tx) => getClaim(tx, f.accountantCtx, claimId));
  expect(claim.status).toBe('submitted');
  expect(claim.postingProposalId).toBe(proposalId);

  const prop = await withTenant(f.accountantCtx, (tx) => getProposal(tx, f.accountantCtx, proposalId));
  expect(prop.type).toBe('posting');
  expect(prop.status).toBe('pending_approval');
  const rationaleText = JSON.stringify(prop.rationale);
  expect(rationaleText).toMatch(/Anna Ozola/); // employee name
  expect(rationaleText).toMatch(/12\.10/); // claim total (10.00 net + 2.10 vat)

  // Payload IS the NewJournalEntry (postApprovedPosting posts prop.payload directly, same as bills).
  const payload = prop.payload as { lines: unknown[] };
  expect(payload.lines).toHaveLength(3); // expense (net) + VAT input + settlement
});

test('approving + posting the proposal posts the exact entry and flips the claim to approved', async () => {
  const f = await setup();
  const { claimId, proposalId } = await withTenant(f.accountantCtx, async (tx) => {
    await createAccount(tx, f.accountantCtx, { code: '7550', name: 'Travel & subsistence', type: 'expense' });
    await createAccount(tx, f.accountantCtx, { code: '7570', name: 'Mileage', type: 'expense' });
    await createAccount(tx, f.accountantCtx, { code: '5722', name: 'VAT input (expenses)', type: 'asset' });
    await createAccount(tx, f.accountantCtx, { code: '5610', name: 'Employee settlements', type: 'liability' });
    await openPeriod(tx, f.accountantCtx, { year: 2026, month: 7 });
    const { claimId } = await saveClaim(tx, f.accountantCtx, {
      employeeId: f.employeeAId, description: 'July expenses',
      lines: [RECEIPT_DEDUCTIBLE, RECEIPT_NONDEDUCTIBLE, MILEAGE],
    });
    const { proposalId } = await submitClaim(tx, f.accountantCtx, claimId, ACCOUNTS);
    return { claimId, proposalId };
  });

  const { entryId } = await withTenant(f.accountantCtx, async (tx) => {
    await approveProposal(tx, f.accountantCtx, proposalId);
    return postApprovedPosting(tx, f.accountantCtx, proposalId);
  });

  const claim = await withTenant(f.accountantCtx, (tx) => getClaim(tx, f.accountantCtx, claimId));
  expect(claim.status).toBe('approved');
  expect(claim.journalEntryId).toBe(entryId);

  const entries = await withTenant(f.accountantCtx, (tx) => listJournalEntries(tx, f.accountantCtx, {}));
  const entry = entries.find((e) => e.id === entryId)!;
  expect(entry.lines).toHaveLength(5);
  // DR 7550 x2 (deductible line's net, non-deductible line's gross), DR 7570 mileage net,
  // DR 5722 the deductible line's VAT, CR 5610 the claim's gross total.
  const dr7550 = entry.lines.filter((l) => l.accountCode === '7550').map((l) => l.debit).sort();
  expect(dr7550).toEqual(['10.00', '6.05'].sort());
  expect(entry.lines.find((l) => l.accountCode === '7570')!.debit).toBe('3.75');
  expect(entry.lines.find((l) => l.accountCode === '5722')!.debit).toBe('2.10');
  expect(entry.lines.find((l) => l.accountCode === '5610')!.credit).toBe('21.90');
});

test('rejecting the proposal returns the claim to draft and clears posting_proposal_id', async () => {
  const f = await setup();
  const { claimId, proposalId } = await withTenant(f.accountantCtx, async (tx) => {
    const { claimId } = await saveClaim(tx, f.accountantCtx, {
      employeeId: f.employeeAId, description: 'July expenses', lines: [RECEIPT_DEDUCTIBLE],
    });
    const { proposalId } = await submitClaim(tx, f.accountantCtx, claimId, ACCOUNTS);
    return { claimId, proposalId };
  });

  await withTenant(f.accountantCtx, (tx) => rejectProposal(tx, f.accountantCtx, proposalId, 'missing receipt'));

  const claim = await withTenant(f.accountantCtx, (tx) => getClaim(tx, f.accountantCtx, claimId));
  expect(claim.status).toBe('draft');
  expect(claim.postingProposalId).toBeNull();
});

test('submitClaim refuses empty and zero-total claims, and non-drafts', async () => {
  const f = await setup();

  // Zero-total: a mileage line with 0 km computes to 0 net cents.
  const { claimId: zeroId } = await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeAId, description: 'Zero',
    lines: [{ kind: 'mileage', lineDate: '2026-07-01', description: 'None', expenseAccount: '7570', km: '0' }],
  }));
  await expect(withTenant(f.accountantCtx, (tx) => submitClaim(tx, f.accountantCtx, zeroId, ACCOUNTS)))
    .rejects.toThrow(/zero-total|total/i);

  // Empty: no lines at all (bypassing saveClaim's min(1) line requirement via a direct insert).
  const emptyRes = await withTenant(f.accountantCtx, (tx) => tx.query(
    `INSERT INTO expense_claims(client_company_id, employee_id, description) VALUES ($1,$2,'Empty') RETURNING id`,
    [f.clientCompanyId, f.employeeAId],
  ));
  const emptyId = emptyRes.rows[0].id as string;
  await expect(withTenant(f.accountantCtx, (tx) => submitClaim(tx, f.accountantCtx, emptyId, ACCOUNTS)))
    .rejects.toThrow(/empty/i);

  // Non-draft: submitting twice.
  const { claimId: subId } = await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeAId, description: 'Submitted', lines: [RECEIPT_DEDUCTIBLE],
  }));
  await withTenant(f.accountantCtx, (tx) => submitClaim(tx, f.accountantCtx, subId, ACCOUNTS));
  await expect(withTenant(f.accountantCtx, (tx) => submitClaim(tx, f.accountantCtx, subId, ACCOUNTS)))
    .rejects.toThrow(/draft/i);
});

test('submitClaim respects self-scope: an employee cannot submit another employee\'s claim', async () => {
  const f = await setup();
  const { claimId } = await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeBId, description: "B's claim", lines: [RECEIPT_DEDUCTIBLE],
  }));
  await expect(withTenant(f.employeeACtx, (tx) => submitClaim(tx, f.employeeACtx, claimId, ACCOUNTS)))
    .rejects.toThrow(/forbidden/i);
});

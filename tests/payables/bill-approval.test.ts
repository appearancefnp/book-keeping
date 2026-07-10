import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { getEntry } from '../../src/ledger/posting.js';
import { createBill, getBill } from '../../src/payables/bills.js';

const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seedBill() {
  const t = await makeFirmAndClient();
  const setup = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'VAT input', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    const v = await createParty(tx, ctx(t), { kind: 'vendor', name: 'Acme' });
    return createBill(tx, ctx(t), {
      vendorPartyId: v.id, billNumber: 'INV-9', issueDate: '2026-03-10', dueDate: '2026-04-09', currency: 'EUR',
      lines: [{ description: 'Svc', expenseAccount: '7710', net: '200.00', vatRate: 21, vat: '42.00' }],
    }, ACCTS);
  });
  return { t, ...setup };
}

test('approving a bill proposal posts the payable and opens the bill', async () => {
  const { t, billId, proposalId } = await seedBill();
  const { entryId } = await withTenant(ctx(t), async (tx) => {
    await approveProposal(tx, ctx(t), proposalId);
    return postApprovedPosting(tx, ctx(t), proposalId);
  });
  const detail = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(detail.status).toBe('open');
  expect(detail.journalEntryId).toBe(entryId);

  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), entryId));
  // DR expense 200, DR VAT 42, CR payables 242
  const totalDebit = entry.lines.reduce((a, l) => a + Number(l.debit), 0);
  const totalCredit = entry.lines.reduce((a, l) => a + Number(l.credit), 0);
  expect(totalDebit).toBeCloseTo(242);
  expect(totalCredit).toBeCloseTo(242);
});

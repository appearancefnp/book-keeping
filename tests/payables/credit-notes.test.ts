import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { getEntry } from '../../src/ledger/posting.js';
import {
  buildCreditNoteEntry, createVendorCreditNote, getVendorCreditNote,
  type NewVendorCreditNote,
} from '../../src/payables/credit-notes.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('migration adds doc_type to einvoices and vendor_credit_notes tables', async () => {
  const t = await makeFirmAndClient();
  const cols = await withTenant(ctx(t), async (tx) =>
    (await tx.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'einvoices' AND column_name IN ('doc_type','corrected_invoice_number')`,
    )).rows.map((r) => r.column_name).sort(),
  );
  expect(cols).toEqual(['corrected_invoice_number', 'doc_type']);

  const tbl = await withTenant(ctx(t), async (tx) =>
    (await tx.query(
      `SELECT to_regclass('public.vendor_credit_notes') AS a, to_regclass('public.vendor_credit_note_lines') AS b`,
    )).rows[0],
  );
  expect(tbl.a).toBe('vendor_credit_notes');
  expect(tbl.b).toBe('vendor_credit_note_lines');
});

const CN_ACCTS = { vatInputAccount: '5722', payablesAccount: '5310' };

const sampleCn = (vendorPartyId: string): NewVendorCreditNote => ({
  vendorPartyId, creditNoteNumber: 'VCN-7', issueDate: '2026-03-20', currency: 'EUR',
  correctedBillNumber: 'INV-42',
  lines: [{ description: 'Return', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '21.00' }],
});

async function seedVendor() {
  const t = await makeFirmAndClient();
  const vendor = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5722', name: 'VAT input', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return createParty(tx, ctx(t), { kind: 'vendor', name: 'Acme Supplies' });
  });
  return { t, vendorId: vendor.id };
}

test('buildCreditNoteEntry reverses the bill: DR payables / CR expense / CR VAT-input', () => {
  const entry = buildCreditNoteEntry(sampleCn('v'), CN_ACCTS);
  const debit = entry.lines.reduce((a, l) => a + Number(l.debit), 0);
  const credit = entry.lines.reduce((a, l) => a + Number(l.credit), 0);
  expect(debit).toBeCloseTo(121);
  expect(credit).toBeCloseTo(121);
  const payable = entry.lines.find((l) => l.accountCode === '5310')!;
  expect(payable.debit).toBe('121.00'); // payables reduced (debit)
  const vat = entry.lines.find((l) => l.accountCode === '5722')!;
  expect(vat.credit).toBe('21.00'); // input VAT reversed (credit)
});

test('buildCreditNoteEntry omits the VAT line when VAT is zero', () => {
  const entry = buildCreditNoteEntry({
    ...sampleCn('v'), lines: [{ description: 'x', expenseAccount: '7710', net: '50.00', vatRate: 0, vat: '0.00' }],
  }, CN_ACCTS);
  expect(entry.lines.find((l) => l.accountCode === '5722')).toBeUndefined();
  expect(entry.lines).toHaveLength(2); // CR expense + DR payables
});

test('createVendorCreditNote writes the credit note, lines, and a pending posting proposal', async () => {
  const { t, vendorId } = await seedVendor();
  const { creditNoteId, proposalId } = await withTenant(ctx(t), (tx) => createVendorCreditNote(tx, ctx(t), sampleCn(vendorId), CN_ACCTS));
  const detail = await withTenant(ctx(t), (tx) => getVendorCreditNote(tx, ctx(t), creditNoteId));
  expect(detail.status).toBe('awaiting_approval');
  expect(detail.grandTotalCents).toBe('12100');
  expect(detail.vendorName).toBe('Acme Supplies');
  expect(detail.correctedBillNumber).toBe('INV-42');
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect(prop.type).toBe('posting');
  expect(prop.status).toBe('pending_approval');
});

test('approving the proposal posts the reversal and flips the credit note to applied', async () => {
  const { t, vendorId } = await seedVendor();
  const { creditNoteId, proposalId } = await withTenant(ctx(t), (tx) => createVendorCreditNote(tx, ctx(t), sampleCn(vendorId), CN_ACCTS));
  const detail = await withTenant(ctx(t), async (tx) => {
    await approveProposal(tx, ctx(t), proposalId);
    await postApprovedPosting(tx, ctx(t), proposalId);
    return getVendorCreditNote(tx, ctx(t), creditNoteId);
  });
  expect(detail.status).toBe('applied');
  expect(detail.journalEntryId).not.toBeNull();
  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), detail.journalEntryId!));
  expect(entry.lines).toHaveLength(3);
});

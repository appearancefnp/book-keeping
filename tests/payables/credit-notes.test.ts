import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { getEntry, type NewJournalEntry } from '../../src/ledger/posting.js';
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

const CN_ACCTS = { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' };

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

test('createVendorCreditNote rejects negative line amounts', async () => {
  const { t, vendorId } = await seedVendor();
  await expect(withTenant(ctx(t), (tx) => createVendorCreditNote(tx, ctx(t), {
    ...sampleCn(vendorId),
    lines: [{ description: 'x', expenseAccount: '7710', net: '-100.00', vatRate: 21, vat: '0.00' }],
  }, CN_ACCTS))).rejects.toThrow();
});

test('a reverse-charge vendor credit note reverses both self-assessed legs', async () => {
  const { t, vendorId } = await seedVendor();
  await withTenant(ctx(t), (tx) => createAccount(tx, ctx(t), { code: '5721', name: 'VAT output', type: 'liability' }));

  const { creditNoteId, proposalId } = await withTenant(ctx(t), (tx) => createVendorCreditNote(tx, ctx(t), {
    vendorPartyId: vendorId, creditNoteNumber: 'VCN-RC-1', issueDate: '2026-03-20',
    currency: 'EUR', correctedBillNumber: null,
    lines: [{ description: 'EU service credit', expenseAccount: '7710', net: '1000.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' }],
  }, CN_ACCTS));

  const detail = await withTenant(ctx(t), (tx) => getVendorCreditNote(tx, ctx(t), creditNoteId));
  expect(detail.lines[0]!.vatCategory).toBe('AE');
  expect(detail.lines[0]!.vatDeductible).toBe(true);

  // The proposal payload is the reversal: CR expense 1000, CR input VAT 210, DR payables 1000, DR output VAT 210.
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  const payload = prop.payload as NewJournalEntry;
  expect(payload.lines.find((l) => l.accountCode === '5722')?.credit).toBe('210.00');
  expect(payload.lines.find((l) => l.accountCode === '5721')?.debit).toBe('210.00');
  expect(payload.lines.find((l) => l.accountCode === '5310')?.debit).toBe('1000.00');
  const debit = payload.lines.reduce((a, l) => a + Number(l.debit), 0);
  const credit = payload.lines.reduce((a, l) => a + Number(l.credit), 0);
  expect(debit).toBeCloseTo(credit);

  // The full flow posts cleanly too — proves the accounts referenced by the reversal actually exist.
  await withTenant(ctx(t), async (tx) => {
    await approveProposal(tx, ctx(t), proposalId);
    await postApprovedPosting(tx, ctx(t), proposalId);
  });
  const posted = await withTenant(ctx(t), (tx) => getVendorCreditNote(tx, ctx(t), creditNoteId));
  expect(posted.status).toBe('applied');
  expect(posted.journalEntryId).not.toBeNull();
});

test('a non-deductible reverse-charge vendor credit note posts the VAT into the expense reversal, no VAT-input leg', async () => {
  const { t, vendorId } = await seedVendor();
  await withTenant(ctx(t), (tx) => createAccount(tx, ctx(t), { code: '5721', name: 'VAT output', type: 'liability' }));

  const { creditNoteId, proposalId } = await withTenant(ctx(t), (tx) => createVendorCreditNote(tx, ctx(t), {
    vendorPartyId: vendorId, creditNoteNumber: 'VCN-RC-2', issueDate: '2026-03-20',
    currency: 'EUR', correctedBillNumber: null,
    lines: [{ description: 'EU goods credit (non-deductible)', expenseAccount: '7710', net: '500.00', vatRate: 12, vat: '0.00', vatCategory: 'K', vatDeductible: false }],
  }, CN_ACCTS));

  const detail = await withTenant(ctx(t), (tx) => getVendorCreditNote(tx, ctx(t), creditNoteId));
  expect(detail.lines[0]!.vatCategory).toBe('K');
  expect(detail.lines[0]!.vatDeductible).toBe(false);

  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  const payload = prop.payload as NewJournalEntry;
  // assessed = 500 * 12% = 60.00; expense reversal carries net + assessed, no 5722 leg.
  expect(payload.lines.find((l) => l.accountCode === '7710')).toMatchObject({ debit: '0', credit: '560.00' });
  expect(payload.lines.find((l) => l.accountCode === '5722')).toBeUndefined();
  expect(payload.lines.find((l) => l.accountCode === '5310')?.debit).toBe('500.00');
  expect(payload.lines.find((l) => l.accountCode === '5721')?.debit).toBe('60.00');
  const debit = payload.lines.reduce((a, l) => a + Number(l.debit), 0);
  const credit = payload.lines.reduce((a, l) => a + Number(l.credit), 0);
  expect(debit).toBeCloseTo(credit);
});

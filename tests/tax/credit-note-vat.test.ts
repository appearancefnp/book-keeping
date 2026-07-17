import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { sendInvoice, sendCreditNote } from '../../src/einvoice/outbound.js';
import { createBill } from '../../src/payables/bills.js';
import { createVendorCreditNote } from '../../src/payables/credit-notes.js';
import { computeVat } from '../../src/tax/vat-compute.js';
import type { EInvoice, ECreditNote } from '../../src/einvoice/ubl.js';

const supplier = { name: 'Us', regNo: '40100000000', vatNo: 'LV40100000000' };
const customer = { name: 'Them', regNo: '40200000000', vatNo: 'LV40200000000' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('a period VAT return nets AR and AP credit notes', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  const config = { outputVatAccount: '5721', inputVatAccount: '5722' };

  const vat = await withTenant(ctx(t), async (tx) => {
    for (const [code, type] of [['2310','asset'],['6110','income'],['5721','liability'],['5722','asset'],['7710','expense'],['5310','liability']] as const) await createAccount(tx, ctx(t), { code, name: code, type });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    const vendor = await createParty(tx, ctx(t), { kind: 'vendor', name: 'Vend' });

    // Sale: +100 net / +21 output VAT.
    const inv: EInvoice = { invoiceNumber: 'INV-1', issueDate: '2026-03-05', currency: 'EUR', supplier, customer, lines: [{ description: 's', net: '100.00', vatRate: 21, vat: '21.00' }], netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00' };
    await sendInvoice(tx, ctx(t), { invoice: inv, recipientPeppolId: '0088:1', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
    // AR credit note: −21 output VAT.
    const cn: ECreditNote = { invoiceNumber: 'CN-1', issueDate: '2026-03-06', currency: 'EUR', correctedInvoiceNumber: 'INV-1', supplier, customer, lines: [{ description: 'r', net: '20.00', vatRate: 21, vat: '4.20' }], netTotal: '20.00', vatTotal: '4.20', grandTotal: '24.20' };
    await sendCreditNote(tx, ctx(t), { creditNote: cn, recipientPeppolId: '0088:1', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });

    // Bill: +50 input VAT worth 10.50.
    const bill = await createBill(tx, ctx(t), { vendorPartyId: vendor.id, billNumber: 'B-1', issueDate: '2026-03-07', dueDate: '2026-04-06', currency: 'EUR', lines: [{ description: 'p', expenseAccount: '7710', net: '50.00', vatRate: 21, vat: '10.50' }] }, { vatInputAccount: '5722', payablesAccount: '5310' });
    await approveProposal(tx, ctx(t), bill.proposalId);
    await postApprovedPosting(tx, ctx(t), bill.proposalId);
    // AP credit note: −input VAT 4.20.
    const vcn = await createVendorCreditNote(tx, ctx(t), { vendorPartyId: vendor.id, creditNoteNumber: 'VCN-1', issueDate: '2026-03-08', currency: 'EUR', lines: [{ description: 'r', expenseAccount: '7710', net: '20.00', vatRate: 21, vat: '4.20' }] }, { vatInputAccount: '5722', payablesAccount: '5310' });
    await approveProposal(tx, ctx(t), vcn.proposalId);
    await postApprovedPosting(tx, ctx(t), vcn.proposalId);

    return computeVat(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31', config });
  });

  // Output VAT: 21.00 − 4.20 = 16.80 → 1680 cents. Input VAT: 10.50 − 4.20 = 6.30 → 630 cents.
  expect(vat.outputVatCents).toBe('1680');
  expect(vat.inputVatCents).toBe('630');
  expect(vat.netPayableCents).toBe('1050'); // 1680 − 630
});

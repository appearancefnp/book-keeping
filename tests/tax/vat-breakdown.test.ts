import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { sendInvoice, sendCreditNote } from '../../src/einvoice/outbound.js';
import { createBill } from '../../src/payables/bills.js';
import { createVendorCreditNote } from '../../src/payables/credit-notes.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { vatBreakdown } from '../../src/tax/vat-breakdown.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const billAccounts = { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' };
const creditNoteAccounts = { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' };
const period = { fromDate: '2026-06-01', toDate: '2026-06-30' };

async function seed(t: { firmId: string; clientCompanyId: string }) {
  return withTenant(ctx(t), async (tx) => {
    for (const [code, name, type] of [
      ['2310', 'Receivables', 'asset'], ['6110', 'Sales', 'income'], ['7710', 'Expense', 'expense'],
      ['5721', 'Output VAT', 'liability'], ['5722', 'Input VAT', 'asset'], ['5310', 'Payables', 'liability'],
    ] as const) await createAccount(tx, ctx(t), { code, name, type });
    await openPeriod(tx, ctx(t), { year: 2026, month: 6 });
    const vendor = await createParty(tx, ctx(t), { kind: 'vendor', name: 'OU Vendor', regNo: '11111111', vatNo: 'EE101010101', countryCode: 'EE' });
    return vendor.id;
  });
}

function invoice(number: string, lines: EInvoice['lines'], net: string, vat: string, grand: string): EInvoice {
  return {
    invoiceNumber: number, issueDate: '2026-06-15', currency: 'EUR',
    supplier: { name: 'SIA A', regNo: '40100000000', vatNo: 'LV40100000000' },
    customer: { name: 'OU B', regNo: '11111111', vatNo: 'EE101010101' },
    lines, netTotal: net, vatTotal: vat, grandTotal: grand,
  };
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('aggregates sales and purchases per category', async () => {
  const t = await makeFirmAndClient();
  const vendorId = await seed(t);
  const { proposalId } = await withTenant(ctx(t), async (tx) => {
    await sendInvoice(tx, ctx(t), {
      invoice: invoice('S-1', [
        { description: 'Domestic', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' },
        { description: 'EU goods', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' },
      ], '600.00', '21.00', '621.00'),
      recipientPeppolId: '0088:ee', ap: new StubAccessPoint(),
      receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
    });
    return createBill(tx, ctx(t), {
      vendorPartyId: vendorId, billNumber: 'B-1', issueDate: '2026-06-16', dueDate: '2026-07-16', currency: 'EUR',
      lines: [
        { description: 'Domestic', expenseAccount: '7710', net: '200.00', vatRate: 21, vat: '42.00' },
        { description: 'EU service', expenseAccount: '7710', net: '1000.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' },
        { description: 'Representation', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '0.00', vatCategory: 'AE', vatDeductible: false },
      ],
    }, billAccounts);
  });

  // The bill must be APPROVED AND POSTED to count — an 'awaiting_approval' bill has no
  // ledger entry, so including it would make the breakdown report VAT computeVat cannot see.
  await withTenant(ctx(t), async (tx) => {
    await approveProposal(tx, ctx(t), proposalId);
    await postApprovedPosting(tx, ctx(t), proposalId);
  });

  const b = await withTenant(ctx(t), (tx) => vatBreakdown(tx, ctx(t), period));
  const byCat = Object.fromEntries(b.rows.map((r) => [r.category, r]));

  expect(byCat.S!.salesNetCents).toBe('10000');
  expect(byCat.S!.salesVatCents).toBe('2100');
  expect(byCat.K!.salesNetCents).toBe('50000');
  expect(byCat.K!.salesVatCents).toBe('0');
  expect(byCat.S!.purchaseNetCents).toBe('20000');
  expect(byCat.S!.purchaseVatCents).toBe('4200');
  expect(byCat.AE!.purchaseNetCents).toBe('110000');
  expect(byCat.AE!.selfAssessedVatCents).toBe('23100');            // 210.00 + 21.00
  expect(byCat.AE!.selfAssessedDeductibleCents).toBe('21000');     // only the deductible line

  // Document-derived totals: output = sales VAT + all self-assessed; input = purchase VAT + deductible self-assessed.
  expect(b.documentOutputVatCents).toBe('25200');   // 2100 + 23100
  expect(b.documentInputVatCents).toBe('25200');    // 4200 + 21000
});

test('an unapproved bill is invisible — it has no ledger entry to reconcile against', async () => {
  const t = await makeFirmAndClient();
  const vendorId = await seed(t);
  await withTenant(ctx(t), (tx) => createBill(tx, ctx(t), {
    vendorPartyId: vendorId, billNumber: 'B-PENDING', issueDate: '2026-06-16', dueDate: '2026-07-16', currency: 'EUR',
    lines: [{ description: 'Domestic', expenseAccount: '7710', net: '200.00', vatRate: 21, vat: '42.00' }],
  }, billAccounts));

  const b = await withTenant(ctx(t), (tx) => vatBreakdown(tx, ctx(t), period));
  expect(b.rows).toEqual([]);
  expect(b.documentInputVatCents).toBe('0');
});

test('an AR credit note is subtracted from sales, matching the ledger reversal', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), async (tx) => {
    await sendInvoice(tx, ctx(t), {
      invoice: invoice('S-CN-1', [{ description: 'Goods', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' }], '100.00', '21.00', '121.00'),
      recipientPeppolId: '0088:ee', ap: new StubAccessPoint(),
      receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
    });
    await sendCreditNote(tx, ctx(t), {
      creditNote: { ...invoice('CN-1', [{ description: 'Return', net: '20.00', vatRate: 21, vat: '4.20', vatCategory: 'S' }], '20.00', '4.20', '24.20'), correctedInvoiceNumber: 'S-CN-1' },
      recipientPeppolId: '0088:ee', ap: new StubAccessPoint(),
      receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
    });
  });

  const b = await withTenant(ctx(t), (tx) => vatBreakdown(tx, ctx(t), period));
  const s = b.rows.find((r) => r.category === 'S')!;
  expect(s.salesNetCents).toBe('8000');            // 100.00 - 20.00
  expect(s.salesVatCents).toBe('1680');            // 21.00 - 4.20, exactly what computeVat reports
  expect(b.documentOutputVatCents).toBe('1680');
});

test('a posted vendor credit note is subtracted from purchases', async () => {
  const t = await makeFirmAndClient();
  const vendorId = await seed(t);
  const ids = await withTenant(ctx(t), async (tx) => {
    const bill = await createBill(tx, ctx(t), {
      vendorPartyId: vendorId, billNumber: 'B-CN-1', issueDate: '2026-06-10', dueDate: '2026-07-10', currency: 'EUR',
      lines: [{ description: 'Goods', expenseAccount: '7710', net: '200.00', vatRate: 21, vat: '42.00' }],
    }, billAccounts);
    const cn = await createVendorCreditNote(tx, ctx(t), {
      vendorPartyId: vendorId, creditNoteNumber: 'VCN-1', issueDate: '2026-06-20', currency: 'EUR',
      correctedBillNumber: 'B-CN-1',
      lines: [{ description: 'Return', expenseAccount: '7710', net: '50.00', vatRate: 21, vat: '10.50' }],
    }, creditNoteAccounts);
    return { billProposal: bill.proposalId, cnProposal: cn.proposalId };
  });
  await withTenant(ctx(t), async (tx) => {
    for (const p of [ids.billProposal, ids.cnProposal]) {
      await approveProposal(tx, ctx(t), p);
      await postApprovedPosting(tx, ctx(t), p);
    }
  });

  const b = await withTenant(ctx(t), (tx) => vatBreakdown(tx, ctx(t), period));
  const s = b.rows.find((r) => r.category === 'S')!;
  expect(s.purchaseNetCents).toBe('15000');        // 200.00 - 50.00
  expect(s.purchaseVatCents).toBe('3150');         // 42.00 - 10.50
  expect(b.documentInputVatCents).toBe('3150');
});

test('excludes documents outside the period', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), (tx) => sendInvoice(tx, ctx(t), {
    invoice: invoice('S-2', [{ description: 'X', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' }], '100.00', '21.00', '121.00'),
    recipientPeppolId: '0088:ee', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));
  const b = await withTenant(ctx(t), (tx) => vatBreakdown(tx, ctx(t), { fromDate: '2026-07-01', toDate: '2026-07-31' }));
  expect(b.rows).toEqual([]);
  expect(b.documentOutputVatCents).toBe('0');
});

test('an empty period returns zeroed totals, not an error', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const b = await withTenant(ctx(t), (tx) => vatBreakdown(tx, ctx(t), period));
  expect(b.rows).toEqual([]);
  expect(b.documentOutputVatCents).toBe('0');
  expect(b.documentInputVatCents).toBe('0');
});

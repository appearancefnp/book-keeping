import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { createBill } from '../../src/payables/bills.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { vatBreakdown } from '../../src/tax/vat-breakdown.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const billAccounts = { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' };
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
  await withTenant(ctx(t), async (tx) => {
    await sendInvoice(tx, ctx(t), {
      invoice: invoice('S-1', [
        { description: 'Domestic', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' },
        { description: 'EU goods', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' },
      ], '600.00', '21.00', '621.00'),
      recipientPeppolId: '0088:ee', ap: new StubAccessPoint(),
      receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
    });
    await createBill(tx, ctx(t), {
      vendorPartyId: vendorId, billNumber: 'B-1', issueDate: '2026-06-16', dueDate: '2026-07-16', currency: 'EUR',
      lines: [
        { description: 'Domestic', expenseAccount: '7710', net: '200.00', vatRate: 21, vat: '42.00' },
        { description: 'EU service', expenseAccount: '7710', net: '1000.00', vatRate: 21, vat: '0.00', vatCategory: 'AE' },
        { description: 'Representation', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '0.00', vatCategory: 'AE', vatDeductible: false },
      ],
    }, billAccounts);
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

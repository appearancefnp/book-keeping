import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { buildUblInvoice, type EInvoice } from '../../src/einvoice/ubl.js';
import { receiveInboundInvoices } from '../../src/einvoice/inbound.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { getBill } from '../../src/payables/bills.js';

const template = { expenseAccount: '7710', vatInputAccount: '5722', payablesAccount: '5310' };
const accounts = { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' };
const inv: EInvoice = {
  invoiceNumber: 'SUP-INV-9', issueDate: '2026-03-12', currency: 'EUR',
  supplier: { name: 'SIA Piegādātājs', regNo: '40300000000', vatNo: 'LV40300000000' },
  customer: { name: 'Us', regNo: '40100000000', vatNo: 'LV40100000000' },
  lines: [{ description: 'Materiāli', net: '200.00', vatRate: 21, vat: '42.00' }],
  netTotal: '200.00', vatTotal: '42.00', grandTotal: '242.00',
};

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('inbound Peppol invoice becomes a bill with a pending purchase proposal (no OCR)', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint([{ ublXml: buildUblInvoice(inv) }]);
  const { billIds, proposalIds } = await withTenant(ctx(t), (tx) => receiveInboundInvoices(tx, ctx(t), { ap, template, accounts }));
  expect(billIds).toHaveLength(1);
  expect(proposalIds).toHaveLength(1);
  const p = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalIds[0]!));
  expect(p.type).toBe('posting');
  expect(p.status).toBe('pending_approval');
  const payload = p.payload as { lines: { accountCode: string }[] };
  expect(payload.lines).toHaveLength(3); // expense + input VAT + payable
});

test('no inbound invoices yields no bills or proposals', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint([]);
  const { billIds, proposalIds } = await withTenant(ctx(t), (tx) => receiveInboundInvoices(tx, ctx(t), { ap, template, accounts }));
  expect(billIds).toHaveLength(0);
  expect(proposalIds).toHaveLength(0);
});

test('a mixed inbound invoice keeps VAT off the reverse-charge line', async () => {
  const t = await makeFirmAndClient();
  const xml = buildUblInvoice({
    invoiceNumber: 'IN-MIX-1', issueDate: '2026-06-12', currency: 'EUR',
    supplier: { name: 'OU Vendor', regNo: '11111111', vatNo: 'EE101010101' },
    customer: { name: 'SIA Us', regNo: '40100000000', vatNo: 'LV40100000000' },
    lines: [
      // The vendor states no rate on the reverse-charge line — that is the conformant form.
      { description: 'EU service', net: '200.00', vatRate: 0, vat: '0.00', vatCategory: 'AE' },
      { description: 'Domestic goods', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' },
    ],
    netTotal: '300.00', vatTotal: '21.00', grandTotal: '321.00',
  });
  const ap = new StubAccessPoint([{ ublXml: xml }]);

  const { billIds } = await withTenant(ctx(t), (tx) => receiveInboundInvoices(tx, ctx(t), {
    ap, template, accounts: { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' },
  }));

  const bill = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billIds[0]!));
  expect(bill.lines.map((l) => [l.vatCategory, l.vatCents])).toEqual([['AE', '0'], ['S', '2100']]);
});

test('an inbound invoice where every line is reverse-charge but the declared VAT total is non-zero is rejected', async () => {
  const t = await makeFirmAndClient();
  // Every line is AE (reverse charge) so none of them charges VAT — but the document still
  // declares a non-zero vatTotal, with grandTotal = net + vat so the two existing
  // reconciliation guards both pass. Nothing should book: the declared VAT would otherwise
  // silently vanish from the bill's grand total (underpaying the vendor) while the einvoices
  // row (written from the same declared grandTotal) keeps it.
  const xml = buildUblInvoice({
    invoiceNumber: 'IN-BAD-VAT-1', issueDate: '2026-06-12', currency: 'EUR',
    supplier: { name: 'OU Vendor', regNo: '11111111', vatNo: 'EE101010101' },
    customer: { name: 'SIA Us', regNo: '40100000000', vatNo: 'LV40100000000' },
    lines: [{ description: 'EU service', net: '200.00', vatRate: 0, vat: '0.00', vatCategory: 'AE' }],
    netTotal: '200.00', vatTotal: '42.00', grandTotal: '242.00',
  });
  const ap = new StubAccessPoint([{ ublXml: xml }]);

  await expect(withTenant(ctx(t), (tx) => receiveInboundInvoices(tx, ctx(t), {
    ap, template, accounts: { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' },
  }))).rejects.toThrow(/manual review required/);
});

test('an inbound reverse-charge line is stored at the domestic rate so it self-assesses', async () => {
  const t = await makeFirmAndClient();
  const xml = buildUblInvoice({
    invoiceNumber: 'IN-RC-1', issueDate: '2026-06-12', currency: 'EUR',
    supplier: { name: 'OU Vendor', regNo: '11111111', vatNo: 'EE101010101' },
    customer: { name: 'SIA Us', regNo: '40100000000', vatNo: 'LV40100000000' },
    lines: [{ description: 'EU service', net: '1000.00', vatRate: 0, vat: '0.00', vatCategory: 'AE' }],
    netTotal: '1000.00', vatTotal: '0.00', grandTotal: '1000.00',
  });
  const { billIds } = await withTenant(ctx(t), (tx) => receiveInboundInvoices(tx, ctx(t), {
    ap: new StubAccessPoint([{ ublXml: xml }]),
    template, accounts: { vatInputAccount: '5722', vatOutputAccount: '5721', payablesAccount: '5310' },
  }));

  const bill = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billIds[0]!));
  // Stored at the LV standard rate (21 from tax_rules), not the vendor's 0.
  expect(bill.lines[0]!.vatRate).toBe('21');
  expect(bill.lines[0]!.vatCents).toBe('0');       // nothing was invoiced
  expect(bill.grandTotalCents).toBe('100000');     // the vendor is paid net
});

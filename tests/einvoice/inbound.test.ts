import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { buildUblInvoice, type EInvoice } from '../../src/einvoice/ubl.js';
import { receiveInboundInvoices } from '../../src/einvoice/inbound.js';
import { getProposal } from '../../src/proposals/proposals.js';

const template = { expenseAccount: '7710', vatInputAccount: '5722', payablesAccount: '5310' };
const accounts = { vatInputAccount: '5722', payablesAccount: '5310' };
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

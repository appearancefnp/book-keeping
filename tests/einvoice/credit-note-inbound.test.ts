import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { buildUblCreditNote, type ECreditNote } from '../../src/einvoice/ubl.js';
import { receiveInboundInvoices } from '../../src/einvoice/inbound.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { getVendorCreditNote } from '../../src/payables/credit-notes.js';

const template = { expenseAccount: '7710', vatInputAccount: '5722', payablesAccount: '5310' };
const accounts = { vatInputAccount: '5722', payablesAccount: '5310' };
const cn: ECreditNote = {
  invoiceNumber: 'SUP-CN-3', issueDate: '2026-03-18', currency: 'EUR',
  correctedInvoiceNumber: 'SUP-INV-9',
  supplier: { name: 'SIA Piegādātājs', regNo: '40300000000', vatNo: 'LV40300000000' },
  customer: { name: 'Us', regNo: '40100000000', vatNo: 'LV40100000000' },
  lines: [{ description: 'Atgriešana', net: '200.00', vatRate: 21, vat: '42.00' }],
  netTotal: '200.00', vatTotal: '42.00', grandTotal: '242.00',
};

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('inbound Peppol CreditNote becomes a vendor credit note with a pending proposal', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint([{ ublXml: buildUblCreditNote(cn) }]);
  const { billIds, creditNoteIds, proposalIds } = await withTenant(ctx(t), (tx) => receiveInboundInvoices(tx, ctx(t), { ap, template, accounts }));
  expect(billIds).toHaveLength(0);
  expect(creditNoteIds).toHaveLength(1);
  expect(proposalIds).toHaveLength(1);
  const detail = await withTenant(ctx(t), (tx) => getVendorCreditNote(tx, ctx(t), creditNoteIds[0]!));
  expect(detail.source).toBe('peppol');
  expect(detail.correctedBillNumber).toBe('SUP-INV-9');
  expect(detail.grandTotalCents).toBe('24200');
  const p = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalIds[0]!));
  expect(p.status).toBe('pending_approval');
});

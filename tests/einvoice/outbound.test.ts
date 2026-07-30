import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { getEntry } from '../../src/ledger/posting.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const inv: EInvoice = {
  invoiceNumber: 'INV-2026-001', issueDate: '2026-03-10', currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('sends an invoice: dispatches via AP, posts a receivable, records the einvoice', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  const { einvoiceId, entryId, messageId } = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return sendInvoice(tx, ctx(t), { invoice: inv, recipientPeppolId: '0088:123', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
  });
  expect(messageId).toBeTruthy();
  // receivable posted: DR debtors 121 / CR sales 100 / CR vat 21
  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), entryId));
  expect(entry.lines).toHaveLength(3);
  // einvoice recorded as sent
  const row = await withTenant(ctx(t), async (tx) => (await tx.query('SELECT direction, peppol_status, vid_status FROM einvoices WHERE id = $1', [einvoiceId])).rows[0]);
  expect(row.direction).toBe('outbound');
  expect(row.peppol_status).toBe('sent');
  expect(row.vid_status).toBe('pending'); // awaiting VID submission (Task 6)
  expect(ap.sent).toHaveLength(1);
});

test('sends a zero-VAT invoice: posts a 2-line entry with no VAT line', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  const zeroVatInv: EInvoice = {
    ...inv, invoiceNumber: 'INV-2026-002',
    lines: [{ description: 'Prece (intra-EU)', net: '100.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }],
    netTotal: '100.00', vatTotal: '0.00', grandTotal: '100.00',
  };
  const { entryId } = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return sendInvoice(tx, ctx(t), { invoice: zeroVatInv, recipientPeppolId: '0088:123', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
  });
  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), entryId));
  expect(entry.lines).toHaveLength(2);
  const debits = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
  const credits = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
  expect(debits).toBe(credits);
  expect(debits).toBe(100);
});

test('refuses to send an invalid invoice (fails EN16931 before dispatch)', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  await expect(withTenant(ctx(t), (tx) => sendInvoice(tx, ctx(t), {
    invoice: { ...inv, grandTotal: '999.00' }, recipientPeppolId: '0088:123', ap,
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }))).rejects.toThrow(/EN16931|total/i);
  expect(ap.sent).toHaveLength(0); // never dispatched
});

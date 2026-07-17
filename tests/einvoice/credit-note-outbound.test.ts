import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { getEntry } from '../../src/ledger/posting.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { sendCreditNote } from '../../src/einvoice/outbound.js';
import { listEinvoices } from '../../src/einvoice/query.js';
import type { ECreditNote } from '../../src/einvoice/ubl.js';

const cn: ECreditNote = {
  invoiceNumber: 'CN-2026-001', issueDate: '2026-03-15', currency: 'EUR',
  correctedInvoiceNumber: 'INV-2026-001',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Atgriešana', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('sendCreditNote reverses the receivable and records a credit_note einvoice', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  const { einvoiceId, entryId } = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return sendCreditNote(tx, ctx(t), { creditNote: cn, recipientPeppolId: '0088:123', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
  });

  // Reversal of a sale: DR sales 100 / DR output VAT 21 / CR receivable 121.
  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), entryId));
  const byAcct = Object.fromEntries(entry.lines.map((l) => [l.accountId, l]));
  expect(entry.lines).toHaveLength(3);
  const debitTotal = entry.lines.reduce((a, l) => a + Number(l.debit), 0);
  const creditTotal = entry.lines.reduce((a, l) => a + Number(l.credit), 0);
  expect(debitTotal).toBeCloseTo(121);
  expect(creditTotal).toBeCloseTo(121);

  const rows = await withTenant(ctx(t), (tx) => listEinvoices(tx, ctx(t), { direction: 'outbound' }));
  const row = rows.find((r) => r.id === einvoiceId)!;
  expect(row.docType).toBe('credit_note');
  expect(row.correctedInvoiceNumber).toBe('INV-2026-001');
  expect(ap.sent).toHaveLength(1);
});

test('sendCreditNote refuses an unbalanced credit note before dispatch', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  await expect(withTenant(ctx(t), (tx) => sendCreditNote(tx, ctx(t), {
    creditNote: { ...cn, grandTotal: '999.00' }, recipientPeppolId: '0088:123', ap,
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }))).rejects.toThrow(/EN16931|total/i);
  expect(ap.sent).toHaveLength(0);
});

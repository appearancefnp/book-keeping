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
  const { einvoiceId, entryId, receivableId, salesId, vatId } = await withTenant(ctx(t), async (tx) => {
    const receivable = await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    const sales = await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    const vat = await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    const result = await sendCreditNote(tx, ctx(t), { creditNote: cn, recipientPeppolId: '0088:123', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
    return { ...result, receivableId: receivable.id, salesId: sales.id, vatId: vat.id };
  });

  // Reversal of a sale: DR sales 100 / DR output VAT 21 / CR receivable 121.
  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), entryId));
  expect(entry.lines).toHaveLength(3);

  const salesLine = entry.lines.find((l) => l.accountId === salesId)!;
  expect(salesLine.debit).toBe('100.00');
  expect(salesLine.credit).toBe('0.00');

  const vatLine = entry.lines.find((l) => l.accountId === vatId)!;
  expect(vatLine.debit).toBe('21.00');
  expect(vatLine.credit).toBe('0.00');

  const receivableLine = entry.lines.find((l) => l.accountId === receivableId)!;
  expect(receivableLine.debit).toBe('0.00');
  expect(receivableLine.credit).toBe('121.00');

  const rows = await withTenant(ctx(t), (tx) => listEinvoices(tx, ctx(t), { direction: 'outbound' }));
  const row = rows.find((r) => r.id === einvoiceId)!;
  expect(row.docType).toBe('credit_note');
  expect(row.correctedInvoiceNumber).toBe('INV-2026-001');
  expect(ap.sent).toHaveLength(1);
});

test('sendCreditNote without a correctedInvoiceNumber records a null reference', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  const { correctedInvoiceNumber: _omit, ...cnWithoutRef } = cn;
  const { einvoiceId } = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return sendCreditNote(tx, ctx(t), { creditNote: cnWithoutRef, recipientPeppolId: '0088:123', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
  });

  const rows = await withTenant(ctx(t), (tx) => listEinvoices(tx, ctx(t), { direction: 'outbound' }));
  const row = rows.find((r) => r.id === einvoiceId)!;
  expect(row.docType).toBe('credit_note');
  expect(row.correctedInvoiceNumber).toBeNull();
});

test('sendCreditNote with zero VAT posts a 2-line entry with no VAT line', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  const zeroVatCn: ECreditNote = {
    ...cn, invoiceNumber: 'CN-2026-002',
    lines: [{ description: 'Atgriešana (intra-EU)', net: '100.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }],
    netTotal: '100.00', vatTotal: '0.00', grandTotal: '100.00',
  };
  const { entryId, salesId, vatId, receivableId } = await withTenant(ctx(t), async (tx) => {
    const receivable = await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    const sales = await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    const vat = await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    const result = await sendCreditNote(tx, ctx(t), { creditNote: zeroVatCn, recipientPeppolId: '0088:123', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
    return { ...result, receivableId: receivable.id, salesId: sales.id, vatId: vat.id };
  });

  const entry = await withTenant(ctx(t), (tx) => getEntry(tx, ctx(t), entryId));
  expect(entry.lines).toHaveLength(2);
  const debits = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
  const credits = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
  expect(debits).toBe(credits);
  expect(debits).toBe(100);

  // No line should hit the VAT account.
  expect(entry.lines.some((l) => l.accountId === vatId)).toBe(false);
  const salesLine = entry.lines.find((l) => l.accountId === salesId)!;
  expect(salesLine.debit).toBe('100.00');
  const receivableLine = entry.lines.find((l) => l.accountId === receivableId)!;
  expect(receivableLine.credit).toBe('100.00');
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

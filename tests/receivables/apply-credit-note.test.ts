import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { getReceivable } from '../../src/receivables/receivables.js';
import { sendCreditNote } from '../../src/einvoice/outbound.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { runDunning } from '../../src/dunning/dunning.js';
import { setup, issueOpenReceivable, SAMPLE_INVOICE } from './helpers.js';
import type { ECreditNote } from '../../src/einvoice/ubl.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const BASE_CN: ECreditNote = {
  invoiceNumber: 'CN-2026-001', issueDate: '2026-03-15', currency: 'EUR',
  correctedInvoiceNumber: 'INV-2026-001',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Atgriešana', net: '33.06', vatRate: 21, vat: '6.94' }],
  netTotal: '33.06', vatTotal: '6.94', grandTotal: '40.00',
};

test('a referenced credit note reduces the invoice outstanding and advances status', async () => {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId); // grand 12100

  const ap = new StubAccessPoint();
  const { einvoiceId: cnId, entryId } = await withTenant(cid, (tx) => sendCreditNote(tx, cid, {
    creditNote: BASE_CN, recipientPeppolId: '0088:123', ap,
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));

  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.amountPaidCents).toBe('4000');
  expect(r.status).toBe('partially_paid');

  const pay = await withTenant(cid, (tx) => tx.query(
    `SELECT method, credit_note_einvoice_id AS "creditNoteEinvoiceId", journal_entry_id AS "journalEntryId", amount_cents::text AS "amountCents"
       FROM invoice_payments WHERE einvoice_id = $1`,
    [einvoiceId],
  ));
  expect(pay.rows).toHaveLength(1);
  expect(pay.rows[0].method).toBe('credit_note');
  expect(pay.rows[0].creditNoteEinvoiceId).toBe(cnId);
  expect(pay.rows[0].journalEntryId).toBe(entryId);
  expect(pay.rows[0].amountCents).toBe('4000');
});

test('a fully-covering referenced credit note marks the invoice paid and dunning stops chasing it', async () => {
  const { cid, customerId } = await setup();
  const smallInvoice = { ...SAMPLE_INVOICE, invoiceNumber: 'INV-2026-002', netTotal: '41.32', vatTotal: '8.68', grandTotal: '50.00', lines: [{ description: 'Prece', net: '41.32', vatRate: 21, vat: '8.68' }] };
  const { einvoiceId } = await issueOpenReceivable(cid, customerId, { invoice: smallInvoice, dueDate: '2026-03-12' }); // past due

  const ap = new StubAccessPoint();
  const cn: ECreditNote = { ...BASE_CN, invoiceNumber: 'CN-2026-002', correctedInvoiceNumber: 'INV-2026-002', netTotal: '41.32', vatTotal: '8.68', grandTotal: '50.00', lines: [{ description: 'Atgriešana', net: '41.32', vatRate: 21, vat: '8.68' }] };
  await withTenant(cid, (tx) => sendCreditNote(tx, cid, {
    creditNote: cn, recipientPeppolId: '0088:123', ap,
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));

  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('paid');
  expect(r.amountPaidCents).toBe('5000');

  const dunningResult = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-04-01' }));
  expect(dunningResult.prompted).toBe(0);
});

test('a credit note larger than the outstanding applies only the outstanding', async () => {
  const { cid, customerId } = await setup();
  const smallInvoice = { ...SAMPLE_INVOICE, invoiceNumber: 'INV-2026-003', netTotal: '24.79', vatTotal: '5.21', grandTotal: '30.00', lines: [{ description: 'Prece', net: '24.79', vatRate: 21, vat: '5.21' }] };
  const { einvoiceId } = await issueOpenReceivable(cid, customerId, { invoice: smallInvoice });

  const ap = new StubAccessPoint();
  const cn: ECreditNote = { ...BASE_CN, invoiceNumber: 'CN-2026-003', correctedInvoiceNumber: 'INV-2026-003', netTotal: '82.64', vatTotal: '17.36', grandTotal: '100.00', lines: [{ description: 'Atgriešana', net: '82.64', vatRate: 21, vat: '17.36' }] };
  await withTenant(cid, (tx) => sendCreditNote(tx, cid, {
    creditNote: cn, recipientPeppolId: '0088:123', ap,
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));

  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('paid');
  expect(r.amountPaidCents).toBe('3000');

  const pay = await withTenant(cid, (tx) => tx.query(
    `SELECT amount_cents::text AS "amountCents" FROM invoice_payments WHERE einvoice_id = $1`,
    [einvoiceId],
  ));
  expect(pay.rows).toHaveLength(1);
  expect(pay.rows[0].amountCents).toBe('3000');
});

test('an unresolvable or unreferenced credit note applies nothing', async () => {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId); // grand 12100

  const ap = new StubAccessPoint();
  const unresolvableCn: ECreditNote = { ...BASE_CN, invoiceNumber: 'CN-2026-004', correctedInvoiceNumber: 'NOPE' };
  await withTenant(cid, (tx) => sendCreditNote(tx, cid, {
    creditNote: unresolvableCn, recipientPeppolId: '0088:123', ap,
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));

  const { correctedInvoiceNumber: _omit, ...unreferencedCn } = { ...BASE_CN, invoiceNumber: 'CN-2026-005' };
  await withTenant(cid, (tx) => sendCreditNote(tx, cid, {
    creditNote: unreferencedCn as ECreditNote, recipientPeppolId: '0088:123', ap,
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));

  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('open');
  expect(r.amountPaidCents).toBe('0');

  const pay = await withTenant(cid, (tx) => tx.query(`SELECT count(*)::int AS n FROM invoice_payments`));
  expect(pay.rows[0].n).toBe(0);
});

test('a credit note in a different currency does not apply', async () => {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId); // grand 12100, EUR

  const ap = new StubAccessPoint();
  const usdCn: ECreditNote = { ...BASE_CN, invoiceNumber: 'CN-2026-006', currency: 'USD' };
  await withTenant(cid, (tx) => sendCreditNote(tx, cid, {
    creditNote: usdCn, recipientPeppolId: '0088:123', ap,
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));

  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('open');
  expect(r.amountPaidCents).toBe('0');

  const pay = await withTenant(cid, (tx) => tx.query(`SELECT count(*)::int AS n FROM invoice_payments WHERE einvoice_id = $1`, [einvoiceId]));
  expect(pay.rows[0].n).toBe(0);
});

import { expect, test } from 'vitest';
import {
  buildUblCreditNote, parseUblCreditNote, detectUblRoot, buildUblInvoice,
  type ECreditNote,
} from '../../src/einvoice/ubl.js';
import { validateEn16931 } from '../../src/einvoice/validate.js';

const cn: ECreditNote = {
  invoiceNumber: 'CN-2026-001', issueDate: '2026-03-15', currency: 'EUR',
  correctedInvoiceNumber: 'INV-2026-001',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Atgriešana', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

test('buildUblCreditNote emits a CreditNote root with a BillingReference', () => {
  const xml = buildUblCreditNote(cn);
  expect(xml).toContain('<CreditNote');
  expect(xml).toContain('<cac:CreditNoteLine>');
  expect(xml).toContain('<cbc:ID>CN-2026-001</cbc:ID>');
  expect(xml).toContain('INV-2026-001'); // BillingReference
});

test('round-trips build → parse', () => {
  const parsed = parseUblCreditNote(buildUblCreditNote(cn));
  expect(parsed.invoiceNumber).toBe('CN-2026-001');
  expect(parsed.correctedInvoiceNumber).toBe('INV-2026-001');
  expect(parsed.grandTotal).toBe('121.00');
  expect(parsed.lines).toHaveLength(1);
  expect(parsed.lines[0]!.net).toBe('100.00');
});

test('omits BillingReference when there is no corrected invoice', () => {
  const { correctedInvoiceNumber, ...standalone } = cn;
  const xml = buildUblCreditNote(standalone);
  expect(xml).not.toContain('BillingReference');
  expect(parseUblCreditNote(xml).correctedInvoiceNumber).toBeUndefined();
});

test('detectUblRoot distinguishes documents', () => {
  expect(detectUblRoot(buildUblCreditNote(cn))).toBe('CreditNote');
  expect(detectUblRoot(buildUblInvoice({ ...cn }))).toBe('Invoice');
  expect(detectUblRoot('<Foo/>')).toBe('unknown');
});

test('validateEn16931 accepts a well-formed credit note and flags an unbalanced one', () => {
  expect(validateEn16931(cn).valid).toBe(true);
  expect(validateEn16931({ ...cn, grandTotal: '999.00' }).valid).toBe(false);
});

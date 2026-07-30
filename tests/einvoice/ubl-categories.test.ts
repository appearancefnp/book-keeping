import { expect, test } from 'vitest';
import { buildUblInvoice, buildUblCreditNote, parseUblInvoice, parseUblCreditNote, categoryTotals, type EInvoice } from '../../src/einvoice/ubl.js';

const base: EInvoice = {
  invoiceNumber: 'INV-1', issueDate: '2026-06-10', currency: 'EUR',
  supplier: { name: 'SIA Pardevejs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'OU Ostja', regNo: '11111111', vatNo: 'EE101010101' },
  lines: [
    // A sales AE/K line carries rate 0 on the wire (BR-AE-5 / BR-IC-5).
    { description: 'Consulting', net: '1000.00', vatRate: 0, vat: '0.00', vatCategory: 'AE' },
    { description: 'Local part', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' },
  ],
  netTotal: '1100.00', vatTotal: '21.00', grandTotal: '1121.00',
};

test('every line carries the mandatory BT-151 category code', () => {
  const xml = buildUblInvoice(base);
  expect(xml).toContain('<cac:ClassifiedTaxCategory><cbc:ID>AE</cbc:ID>');
  expect(xml).toContain('<cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID>');
});

test('a line with no explicit category defaults to standard rate', () => {
  const xml = buildUblInvoice({ ...base, lines: [{ description: 'X', net: '10.00', vatRate: 21, vat: '2.10' }], netTotal: '10.00', vatTotal: '2.10', grandTotal: '12.10' });
  expect(xml).toContain('<cbc:ID>S</cbc:ID>');
});

test('categoryTotals groups by category and rate, preserving first-seen order', () => {
  expect(categoryTotals(base.lines)).toEqual([
    { category: 'AE', rate: 0, taxableCents: 100000n, taxCents: 0n },
    { category: 'S', rate: 21, taxableCents: 10000n, taxCents: 2100n },
  ]);
});

test('TaxTotal carries one TaxSubtotal per category with its exemption reason', () => {
  const xml = buildUblInvoice(base);
  expect(xml).toContain('<cbc:TaxableAmount currencyID="EUR">1000.00</cbc:TaxableAmount>');
  expect(xml).toContain('<cbc:TaxExemptionReason>Reverse charge</cbc:TaxExemptionReason>');
  expect(xml).toContain('<cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount>');
  // The document-level TaxAmount is unchanged and still the invoiced total.
  expect(xml).toContain('<cac:TaxTotal>\n    <cbc:TaxAmount currencyID="EUR">21.00</cbc:TaxAmount>');
  // Exactly two subtotals.
  expect(xml.match(/<cac:TaxSubtotal>/g)?.length).toBe(2);
});

test('an intra-Community supply emits the VATEX-EU-IC reason code at a zero rate', () => {
  const xml = buildUblInvoice({
    ...base,
    lines: [{ description: 'Goods', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }],
    netTotal: '500.00', vatTotal: '0.00', grandTotal: '500.00',
  });
  expect(xml).toContain('<cbc:TaxExemptionReasonCode>VATEX-EU-IC</cbc:TaxExemptionReasonCode>');
  expect(xml).toContain('<cbc:ID>K</cbc:ID>\n        <cbc:Percent>0</cbc:Percent>');
});

test('the category round-trips through the parser', () => {
  const parsed = parseUblInvoice(buildUblInvoice(base));
  expect(parsed.lines.map((l) => l.vatCategory)).toEqual(['AE', 'S']);
  expect(parsed.lines[0]!.vatRate).toBe(0);   // a wire AE line carries no rate
  expect(parsed.lines[1]!.vatRate).toBe(21);
});

test('a missing or unknown category parses as standard rate', () => {
  // Target the line's ClassifiedTaxCategory ID specifically: the bare '<cbc:ID>AE</cbc:ID>'
  // string is not unique in the document — the per-category TaxSubtotal (which the schema
  // requires before InvoiceLine) carries the identical text and would be replaced first.
  const legacy = buildUblInvoice(base).replace('<cac:ClassifiedTaxCategory><cbc:ID>AE</cbc:ID>', '<cac:ClassifiedTaxCategory><cbc:ID>QQ</cbc:ID>');
  expect(parseUblInvoice(legacy).lines[0]!.vatCategory).toBe('S');
});

test('credit notes get the same treatment', () => {
  const xml = buildUblCreditNote({ ...base, correctedInvoiceNumber: 'INV-0' });
  expect(xml).toContain('<cac:ClassifiedTaxCategory><cbc:ID>AE</cbc:ID>');
  expect(xml.match(/<cac:TaxSubtotal>/g)?.length).toBe(2);
  expect(parseUblCreditNote(xml).lines.map((l) => l.vatCategory)).toEqual(['AE', 'S']);
});

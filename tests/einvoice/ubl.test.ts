import { expect, test } from 'vitest';
import { buildUblInvoice, parseUblInvoice, type EInvoice } from '../../src/einvoice/ubl.js';

const inv: EInvoice = {
  invoiceNumber: 'INV-2026-001', issueDate: '2026-03-10', currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs & Co', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Prece <A>', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

test('builds EN16931-shaped UBL with escaped free text', () => {
  const xml = buildUblInvoice(inv);
  expect(xml).toMatch(/^<\?xml/);
  expect(xml).toContain('<cbc:ID>INV-2026-001</cbc:ID>');
  expect(xml).toContain('<cbc:CustomizationID>urn:cen.eu:en16931:2017');
  expect(xml).toContain('SIA Pārdevējs &amp; Co');       // escaped &
  expect(xml).toContain('Prece &lt;A&gt;');               // escaped < >
  expect(xml).toContain('<cbc:PayableAmount currencyID="EUR">121.00</cbc:PayableAmount>');
});

test('round-trips through parse', () => {
  const xml = buildUblInvoice(inv);
  const parsed = parseUblInvoice(xml);
  expect(parsed.invoiceNumber).toBe('INV-2026-001');
  expect(parsed.currency).toBe('EUR');
  expect(parsed.supplier.name).toBe('SIA Pārdevējs & Co'); // unescaped back
  expect(parsed.grandTotal).toBe('121.00');
  expect(parsed.lines).toHaveLength(1);
  expect(parsed.lines[0]!.net).toBe('100.00');
});

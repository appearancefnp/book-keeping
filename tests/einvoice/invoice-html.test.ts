import { expect, test } from 'vitest';
import { renderInvoiceHtml } from '../../src/einvoice/invoice-html.js';

const inv = {
  invoiceNumber: 'INV-9', issueDate: '2026-07-01', currency: 'EUR',
  supplier: { name: 'Ozola SIA', regNo: '40000000001', vatNo: 'LV40000000001' },
  customer: { name: 'Client <X>', regNo: '2', vatNo: 'LV2' },
  lines: [{ description: 'Consulting', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  dueDate: '2026-07-15', note: 'Thanks', paymentTerms: 'Net 14',
};

test('renders invoice number, parties, lines, totals, note, terms, footer', () => {
  const html = renderInvoiceHtml(inv, { footer: 'Reg. LV123', logoDataUri: null, lang: 'en' });
  expect(html).toContain('INV-9');
  expect(html).toContain('Ozola SIA');
  expect(html).toContain('Consulting');
  expect(html).toContain('121.00');
  expect(html).toContain('Thanks');
  expect(html).toContain('Net 14');
  expect(html).toContain('Reg. LV123');
  expect(html).not.toContain('<img'); // no logo
});

test('escapes interpolated text (no raw < from customer name)', () => {
  const html = renderInvoiceHtml(inv, { footer: null, logoDataUri: null, lang: 'en' });
  expect(html).toContain('Client &lt;X&gt;');
  expect(html).not.toContain('Client <X>');
});

test('includes a logo img when a data URI is given', () => {
  const html = renderInvoiceHtml(inv, { footer: null, logoDataUri: 'data:image/png;base64,AAAA', lang: 'lv' });
  expect(html).toContain('<img');
  expect(html).toContain('data:image/png;base64,AAAA');
});

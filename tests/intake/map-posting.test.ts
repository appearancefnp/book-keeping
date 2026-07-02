import { expect, test } from 'vitest';
import { extractedToJournalEntry, type PostingTemplate } from '../../src/intake/map-posting.js';
import { sumCents } from '../../src/db/money.js';
import type { ExtractedInvoice } from '../../src/intake/extraction-schema.js';

const template: PostingTemplate = { expenseAccount: '7710', vatInputAccount: '5721', payablesAccount: '5310' };
const inv: ExtractedInvoice = {
  supplierName: 'SIA X', supplierRegNo: '40100000000', date: '2026-03-10', currency: 'EUR',
  lineItems: [{ description: 'A', net: '100.00', vatRate: 21, vat: '21.00' }],
  vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
};

test('maps a purchase invoice to a balanced 3-line entry', () => {
  const entry = extractedToJournalEntry(inv, template);
  expect(entry.date).toBe('2026-03-10');
  expect(entry.currency).toBe('EUR');
  const debits = sumCents(entry.lines.map((l) => l.debit));
  const credits = sumCents(entry.lines.map((l) => l.credit));
  expect(debits).toBe(credits);
  // net→expense debit, vat→vat-input debit, gross→payables credit
  const byAcct = Object.fromEntries(entry.lines.map((l) => [l.accountCode, l]));
  expect(byAcct['7710']!.debit).toBe('100.00');
  expect(byAcct['5721']!.debit).toBe('21.00');
  expect(byAcct['5310']!.credit).toBe('121.00');
});

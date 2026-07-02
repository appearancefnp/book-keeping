import { expect, test } from 'vitest';
import { validateExtraction } from '../../src/intake/validate.js';
import type { ExtractedInvoice } from '../../src/intake/extraction-schema.js';

const good: ExtractedInvoice = {
  supplierName: 'SIA X', supplierRegNo: '40100000000', date: '2026-03-10', currency: 'EUR',
  lineItems: [{ description: 'A', net: '100.00', vatRate: 21, vat: '21.00' }],
  vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
};

test('a consistent invoice validates clean', () => {
  const r = validateExtraction(good, { supplierName: 0.99, grandTotal: 0.97 });
  expect(r.valid).toBe(true);
  expect(r.issues).toEqual([]);
});

test('flags a total that does not reconcile', () => {
  const bad = { ...good, grandTotal: '130.00' };
  const r = validateExtraction(bad, { grandTotal: 0.99 });
  expect(r.valid).toBe(false);
  expect(r.issues.join(' ')).toMatch(/reconcile|total/i);
});

test('flags net+vat mismatch against line items', () => {
  const bad = { ...good, netTotal: '90.00' }; // lines sum to 100
  const r = validateExtraction(bad, {});
  expect(r.valid).toBe(false);
});

test('flags low-confidence fields below threshold', () => {
  const r = validateExtraction(good, { supplierName: 0.4 }, { minConfidence: 0.7 });
  expect(r.lowConfidenceFields).toContain('supplierName');
});

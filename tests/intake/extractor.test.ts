import { expect, test } from 'vitest';
import { StubExtractor } from '../../src/intake/extractor.js';
import { extractedInvoiceSchema } from '../../src/intake/extraction-schema.js';

test('StubExtractor returns a schema-valid extraction', async () => {
  const ex = new StubExtractor({
    extractedData: {
      supplierName: 'SIA Piegādātājs', supplierRegNo: '40100000000',
      date: '2026-03-10', currency: 'EUR',
      lineItems: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
      vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
    },
    confidence: { supplierName: 0.98, grandTotal: 0.95 },
  });
  const res = await ex.extract(Buffer.from('x'), 'image/jpeg');
  expect(() => extractedInvoiceSchema.parse(res.extractedData)).not.toThrow();
  expect(res.confidence.grandTotal).toBe(0.95);
});

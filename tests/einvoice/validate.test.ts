import { expect, test } from 'vitest';
import { validateEn16931 } from '../../src/einvoice/validate.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const good: EInvoice = {
  invoiceNumber: 'INV-1', issueDate: '2026-03-10', currency: 'EUR',
  supplier: { name: 'S', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'C', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'A', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

test('a compliant invoice validates', () => {
  const r = validateEn16931(good);
  expect(r.valid).toBe(true);
  expect(r.issues).toEqual([]);
});
test('flags a missing invoice number (BR-2)', () => {
  const r = validateEn16931({ ...good, invoiceNumber: '' });
  expect(r.valid).toBe(false);
  expect(r.issues.join(' ')).toMatch(/number/i);
});
test('flags totals that do not reconcile (BR-CO-15)', () => {
  const r = validateEn16931({ ...good, grandTotal: '130.00' });
  expect(r.valid).toBe(false);
  expect(r.issues.join(' ')).toMatch(/total/i);
});
test('flags a missing supplier VAT id', () => {
  const r = validateEn16931({ ...good, supplier: { ...good.supplier, vatNo: '' } });
  expect(r.valid).toBe(false);
});

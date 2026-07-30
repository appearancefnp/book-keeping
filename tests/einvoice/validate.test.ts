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

const ok: EInvoice = {
  invoiceNumber: 'INV-9', issueDate: '2026-06-10', currency: 'EUR',
  supplier: { name: 'SIA A', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'OU B', regNo: '11111111', vatNo: 'EE101010101' },
  lines: [{ description: 'Goods', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }],
  netTotal: '500.00', vatTotal: '0.00', grandTotal: '500.00',
};

test('an intra-Community supply is valid with a customer VAT id', () => {
  expect(validateEn16931(ok).valid).toBe(true);
});

test('BR-IC-5: a sales intra-Community line may not carry a VAT rate', () => {
  const bad: EInvoice = {
    ...ok,
    lines: [{ description: 'Goods', net: '500.00', vatRate: 21, vat: '0.00', vatCategory: 'K' }],
  };
  expect(validateEn16931(bad).issues.join(' ')).toContain('BR-IC-5');
});

test('BR-IC-1: an intra-Community supply requires a customer VAT identifier', () => {
  const bad = { ...ok, customer: { ...ok.customer, vatNo: '' } };
  const r = validateEn16931(bad);
  expect(r.valid).toBe(false);
  expect(r.issues.join(' ')).toContain('BR-IC-1');
});

test('a reverse-charge line may not carry VAT', () => {
  const bad: EInvoice = {
    ...ok,
    lines: [{ description: 'Svc', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'AE' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  };
  expect(validateEn16931(bad).issues.join(' ')).toContain('BR-AE-8');
});

test('a standard-rated line needs a nonzero rate', () => {
  const bad: EInvoice = {
    ...ok,
    lines: [{ description: 'X', net: '100.00', vatRate: 0, vat: '0.00', vatCategory: 'S' }],
    netTotal: '100.00', vatTotal: '0.00', grandTotal: '100.00',
  };
  expect(validateEn16931(bad).issues.join(' ')).toContain('BR-S-5');
});

test('BR-CO-14: the VAT total must equal the sum of the category subtotals', () => {
  const bad: EInvoice = {
    ...ok,
    lines: [{ description: 'X', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' }],
    netTotal: '100.00', vatTotal: '20.00', grandTotal: '120.00',
  };
  expect(validateEn16931(bad).issues.join(' ')).toContain('BR-CO-14');
});

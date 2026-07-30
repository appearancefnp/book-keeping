import { expect, test } from 'vitest';
import {
  VAT_CATEGORIES, isVatCategory, chargesVat, selfAssesses, inEcsl, ecslSupplyType,
  exemptionReasonFor, selfAssessedVatCents, categoryIssues,
} from '../../src/tax/categories.js';

test('the code list is exactly the EN 16931 subset we support', () => {
  expect([...VAT_CATEGORIES]).toEqual(['S', 'Z', 'E', 'AE', 'K', 'G', 'O']);
  expect(isVatCategory('S')).toBe(true);
  expect(isVatCategory('X')).toBe(false);
});

test('only standard-rated lines charge VAT', () => {
  expect(chargesVat('S')).toBe(true);
  for (const c of ['Z', 'E', 'AE', 'K', 'G', 'O'] as const) expect(chargesVat(c)).toBe(false);
});

test('reverse charge and intra-Community acquisitions self-assess', () => {
  expect(selfAssesses('AE')).toBe(true);
  expect(selfAssesses('K')).toBe(true);
  expect(selfAssesses('S')).toBe(false);
  expect(selfAssesses('E')).toBe(false);
});

test('ECSL covers AE and K, split goods vs services by category', () => {
  expect(inEcsl('K')).toBe(true);
  expect(inEcsl('AE')).toBe(true);
  expect(inEcsl('S')).toBe(false);
  expect(ecslSupplyType('K')).toBe('goods');
  expect(ecslSupplyType('AE')).toBe('services');
  expect(ecslSupplyType('S')).toBe(null);
});

test('exemption reasons follow the BR-*-10 rules; S and Z need none', () => {
  expect(exemptionReasonFor('S')).toBe(null);
  expect(exemptionReasonFor('Z')).toBe(null);
  expect(exemptionReasonFor('K')).toEqual({ code: 'VATEX-EU-IC', text: 'Intra-Community supply' });
  expect(exemptionReasonFor('AE')).toEqual({ text: 'Reverse charge' });
  expect(exemptionReasonFor('E')?.code).toBe('VATEX-EU-132');
  expect(exemptionReasonFor('G')?.code).toBe('VATEX-EU-147');
  expect(exemptionReasonFor('O')?.text).toBe('Not subject to VAT');
});

test('self-assessed VAT rounds half-up per line', () => {
  expect(selfAssessedVatCents(100000n, 21)).toBe(21000n);
  expect(selfAssessedVatCents(1n, 21)).toBe(0n);       // 0.21 cents -> 0
  expect(selfAssessedVatCents(3n, 21)).toBe(1n);       // 0.63 cents -> 1
  expect(selfAssessedVatCents(10050n, 12)).toBe(1206n);
  expect(selfAssessedVatCents(100000n, 0)).toBe(0n);
});

test('categoryIssues enforces rate/VAT consistency per category', () => {
  expect(categoryIssues({ vatCategory: 'S', vatRate: 21, vatCents: 2100n })).toEqual([]);
  expect(categoryIssues({ vatCategory: 'S', vatRate: 0, vatCents: 0n })[0]).toContain('BR-S-5');
  expect(categoryIssues({ vatCategory: 'K', vatRate: 21, vatCents: 0n })).toEqual([]);
  expect(categoryIssues({ vatCategory: 'K', vatRate: 21, vatCents: 2100n })[0]).toContain('BR-IC-8');
  expect(categoryIssues({ vatCategory: 'AE', vatRate: 0, vatCents: 0n })[0]).toContain('BR-AE-5');
  expect(categoryIssues({ vatCategory: 'E', vatRate: 21, vatCents: 0n })[0]).toContain('BR-E-5');
  expect(categoryIssues({ vatCategory: 'Z', vatRate: 0, vatCents: 100n })[0]).toContain('BR-Z-8');
});

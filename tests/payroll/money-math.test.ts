import { expect, test } from 'vitest';
import { fromCents, toCents } from '../../src/db/money.js';
import { applyBp, divRound } from '../../src/payroll/rates.js';

test('fromCents formats cents as a 2dp decimal string', () => {
  expect(fromCents(87077n)).toBe('870.77');
  expect(fromCents(0n)).toBe('0.00');
  expect(fromCents(5n)).toBe('0.05');
  expect(fromCents(-2423n)).toBe('-24.23');
  expect(toCents(fromCents(123456789n))).toBe(123456789n);
});

test('divRound divides with half-up rounding', () => {
  expect(divRound(10n, 4n)).toBe(3n);   // 2.5 -> 3
  expect(divRound(9n, 4n)).toBe(2n);    // 2.25 -> 2
  expect(divRound(550000n, 22n)).toBe(25000n);
  expect(() => divRound(1n, 0n)).toThrow();
});

test('applyBp applies a basis-point rate with half-up rounding', () => {
  // 10.5% of 1000.00 EUR = 105.00
  expect(applyBp(100000n, 1050n)).toBe(10500n);
  // 25.5% of 95.00 = 24.225 -> 24.23
  expect(applyBp(9500n, 2550n)).toBe(2423n);
  // 23.59% of 1000.00 = 235.90
  expect(applyBp(100000n, 2359n)).toBe(23590n);
});

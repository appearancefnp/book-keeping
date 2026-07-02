import { expect, test } from 'vitest';
import { toCents, sumCents } from '../../src/db/money.js';

test('toCents parses decimal strings without float error', () => {
  expect(toCents('100.00')).toBe(10000n);
  expect(toCents('0.1')).toBe(10n);
  expect(toCents('1234567.89')).toBe(123456789n);
});

test('toCents rejects more than two decimal places', () => {
  expect(() => toCents('1.234')).toThrow();
});

test('sumCents adds a list of decimal strings exactly', () => {
  expect(sumCents(['0.10', '0.20'])).toBe(30n); // the classic 0.1 + 0.2 float trap
});

test('toCents parses negative values', () => {
  expect(toCents('-5.50')).toBe(-550n);
  expect(toCents('-0.05')).toBe(-5n);
});

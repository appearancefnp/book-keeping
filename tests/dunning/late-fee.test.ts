import { expect, test } from 'vitest';
import { accruedLateFeeCents } from '../../src/dunning/late-fee.js';

test('zero when no rate and no flat', () => {
  expect(accruedLateFeeCents({ outstandingCents: '100000', daysOverdue: 30, annualBps: 0, flatCents: '0' })).toBe('0');
});

test('flat-only fee is returned verbatim regardless of days', () => {
  expect(accruedLateFeeCents({ outstandingCents: '100000', daysOverdue: 0, annualBps: 0, flatCents: '500' })).toBe('500');
});

test('annual-only interest: 8%/yr on 1000.00 for 365 days = 80.00', () => {
  // 100000 cents * 800bps/10000 * 365/365 = 8000 cents
  expect(accruedLateFeeCents({ outstandingCents: '100000', daysOverdue: 365, annualBps: 800, flatCents: '0' })).toBe('8000');
});

test('annual interest for a partial period rounds half-up', () => {
  // 100000 * 0.08 * 30/365 = 657.53... cents -> 658
  expect(accruedLateFeeCents({ outstandingCents: '100000', daysOverdue: 30, annualBps: 800, flatCents: '0' })).toBe('658');
});

test('flat + annual combine', () => {
  // 658 (interest above) + 500 flat = 1158
  expect(accruedLateFeeCents({ outstandingCents: '100000', daysOverdue: 30, annualBps: 800, flatCents: '500' })).toBe('1158');
});

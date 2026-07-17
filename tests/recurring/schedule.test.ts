import { expect, test } from 'vitest';
import { clampToMonth, advanceRunDate, periodKey, buildRecurringInvoiceNumber } from '../../src/recurring/schedule.js';

test('clampToMonth clamps an out-of-range anchor to the last day', () => {
  expect(clampToMonth(2026, 2, 31)).toBe('2026-02-28'); // Feb, non-leap
  expect(clampToMonth(2024, 2, 31)).toBe('2024-02-29'); // Feb, leap
  expect(clampToMonth(2026, 4, 31)).toBe('2026-04-30'); // 30-day month
  expect(clampToMonth(2026, 1, 15)).toBe('2026-01-15'); // in range, untouched
});

test('advanceRunDate steps by interval months, day from anchor', () => {
  expect(advanceRunDate('2026-01-15', 1, 15)).toBe('2026-02-15');  // monthly
  expect(advanceRunDate('2026-01-31', 1, 31)).toBe('2026-02-28');  // clamp on step
  expect(advanceRunDate('2026-11-15', 3, 15)).toBe('2027-02-15');  // quarterly, year rollover
  expect(advanceRunDate('2026-05-01', 12, 1)).toBe('2027-05-01');  // annual
});

test('periodKey and buildRecurringInvoiceNumber', () => {
  expect(periodKey('2026-05-15')).toBe('2026-05');
  expect(buildRecurringInvoiceNumber('REC', '2026-05-15', 'a1b2c3d4-0000-0000-0000-000000000000'))
    .toBe('REC-2026-05-a1b2c3d4');
  expect(buildRecurringInvoiceNumber(null, '2026-05-15', 'a1b2c3d4-0000-0000-0000-000000000000'))
    .toBe('INV-2026-05-a1b2c3d4');
});

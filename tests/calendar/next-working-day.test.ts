import { expect, test } from 'vitest';
import { nextWorkingDay } from '../../src/calendar/holidays.js';

test('a plain working day is returned unchanged', () => {
  expect(nextWorkingDay('2026-06-22')).toBe('2026-06-22'); // Monday
});

test('a Saturday rolls to Monday', () => {
  expect(nextWorkingDay('2026-06-20')).toBe('2026-06-22');
});

test('a Sunday rolls to Monday', () => {
  expect(nextWorkingDay('2026-06-21')).toBe('2026-06-22');
});

test('a public holiday rolls forward', () => {
  // 2026-06-23 (Līgo) and 2026-06-24 (Jāņi) are LR public holidays; 25 June 2026 is a Thursday.
  expect(nextWorkingDay('2026-06-23')).toBe('2026-06-25');
});

test('the holiday predicate is injectable', () => {
  expect(nextWorkingDay('2026-06-22', (d) => d === '2026-06-22')).toBe('2026-06-23');
});

import { expect, test } from 'vitest';
import { isWorkDay, workDaysInMonth, workDaysOverlap, lastDayOfMonth, calendarDays } from '../../src/payroll/workdays.js';

test('isWorkDay: Mon-Fri true, weekend false', () => {
  expect(isWorkDay('2026-07-06')).toBe(true);  // Monday
  expect(isWorkDay('2026-07-10')).toBe(true);  // Friday
  expect(isWorkDay('2026-07-11')).toBe(false); // Saturday
  expect(isWorkDay('2026-07-12')).toBe(false); // Sunday
});

test('workDaysInMonth', () => {
  expect(workDaysInMonth(2026, 7)).toBe(23);  // July 2026
  expect(workDaysInMonth(2026, 2)).toBe(20);  // Feb 2026
});

test('lastDayOfMonth', () => {
  expect(lastDayOfMonth(2026, 7)).toBe('2026-07-31');
  expect(lastDayOfMonth(2028, 2)).toBe('2028-02-29'); // leap year
});

test('workDaysOverlap clamps a range to one month and counts workdays', () => {
  // Vacation 2026-07-13 (Mon) .. 2026-07-24 (Fri) = 10 workdays, all in July
  expect(workDaysOverlap('2026-07-13', '2026-07-24', 2026, 7)).toBe(10);
  // Range spanning June->July counts only July days
  expect(workDaysOverlap('2026-06-29', '2026-07-03', 2026, 7)).toBe(3); // Jul 1,2,3
  // Disjoint range
  expect(workDaysOverlap('2026-05-01', '2026-05-10', 2026, 7)).toBe(0);
});

test('calendarDays iterates inclusive ISO dates', () => {
  expect([...calendarDays('2026-07-30', '2026-08-02')]).toEqual(
    ['2026-07-30', '2026-07-31', '2026-08-01', '2026-08-02']);
});

test('workDaysInMonth subtracts weekday holidays — December 2026', () => {
  // 23 Mon–Fri days − Dec 24 (Thu), 25 (Fri), 31 (Thu); Dec 26 is a Saturday.
  expect(workDaysInMonth(2026, 12)).toBe(20);
});

test('workDaysInMonth subtracts Līgo/Jāņi — June 2026', () => {
  // 22 Mon–Fri days − Jun 23 (Tue) − Jun 24 (Wed).
  expect(workDaysInMonth(2026, 6)).toBe(20);
});

test('workDaysOverlap skips holidays inside the window', () => {
  // 2026-04-01 (Wed) .. 2026-04-10 (Fri): 8 weekdays − Good Friday (Apr 3) − Easter Monday (Apr 6).
  expect(workDaysOverlap('2026-04-01', '2026-04-10', 2026, 4)).toBe(6);
});

test('isWorkDay is false on a weekday holiday and on the observed Monday', () => {
  expect(isWorkDay('2026-12-25')).toBe(false); // Christmas, Friday
  expect(isWorkDay('2025-05-05')).toBe(false); // observed May 4 (Sunday → Monday)
  expect(isWorkDay('2026-12-28')).toBe(true);  // plain Monday
});

import { describe, expect, test } from 'vitest';
import { latvianHolidays, isLatvianHoliday, easterSunday } from '../../src/calendar/holidays.js';

describe('easterSunday (anonymous Gregorian algorithm)', () => {
  // Reference dates from published ecclesiastical tables.
  test.each([
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
  ])('Easter %i is %s', (year, expected) => {
    expect(easterSunday(year)).toBe(expected);
  });
});

describe('latvianHolidays', () => {
  test('includes the fixed statutory dates for 2026', () => {
    const set = latvianHolidays(2026);
    for (const d of [
      '2026-01-01', // New Year
      '2026-05-01', // Labour Day
      '2026-05-04', // Restoration of Independence
      '2026-06-23', // Līgo
      '2026-06-24', // Jāņi
      '2026-11-18', // Proclamation of the Republic
      '2026-12-24', '2026-12-25', '2026-12-26', // Christmas
      '2026-12-31', // New Year's Eve
    ]) {
      expect(set.has(d)).toBe(true);
    }
  });

  test('includes the Easter-derived movable feasts for 2026 (Easter = 2026-04-05)', () => {
    const set = latvianHolidays(2026);
    expect(set.has('2026-04-03')).toBe(true); // Good Friday (Easter − 2)
    expect(set.has('2026-04-06')).toBe(true); // Easter Monday (Easter + 1)
    expect(set.has('2026-05-24')).toBe(true); // Whit Sunday (Easter + 49)
  });

  test('a plain working day is not a holiday', () => {
    expect(isLatvianHoliday('2026-03-17')).toBe(false);
  });

  test('May 4 falling on a weekend adds the following Monday (2025: May 4 = Sunday)', () => {
    const set = latvianHolidays(2025);
    expect(set.has('2025-05-04')).toBe(true);  // the day itself stays a holiday
    expect(set.has('2025-05-05')).toBe(true);  // observed Monday
  });

  test('Nov 18 falling on a Saturday adds the following Monday (2028: Nov 18 = Saturday)', () => {
    const set = latvianHolidays(2028);
    expect(set.has('2028-11-20')).toBe(true);
  });

  test('no observed days in a year where May 4 and Nov 18 are weekdays (2026)', () => {
    const set = latvianHolidays(2026);
    expect(set.has('2026-05-05')).toBe(false); // May 4 2026 is a Monday
    expect(set.has('2026-11-19')).toBe(false); // Nov 18 2026 is a Wednesday
  });

  test('isLatvianHoliday sees the observed Monday', () => {
    expect(isLatvianHoliday('2025-05-05')).toBe(true);
  });
});

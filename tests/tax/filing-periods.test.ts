import { expect, test } from 'vitest';
import { filingPeriodsFor, currentFilingPeriod, filingPeriodByLabel } from '../../src/tax/filing-periods.js';

test('a monthly year has twelve periods labelled YYYY-MM', () => {
  const p = filingPeriodsFor(2026, 'monthly');
  expect(p.length).toBe(12);
  expect(p[0]).toEqual({ label: '2026-01', fromDate: '2026-01-01', toDate: '2026-01-31', dueDate: '2026-02-20' });
  expect(p[1]!.toDate).toBe('2026-02-28');   // 2026 is not a leap year
  expect(p[11]).toEqual({ label: '2026-12', fromDate: '2026-12-01', toDate: '2026-12-31', dueDate: '2027-01-20' });
});

test('a quarterly year has four periods labelled YYYY-Qn', () => {
  const p = filingPeriodsFor(2026, 'quarterly');
  expect(p.length).toBe(4);
  expect(p[0]).toEqual({ label: '2026-Q1', fromDate: '2026-01-01', toDate: '2026-03-31', dueDate: '2026-04-20' });
  expect(p[3]!.toDate).toBe('2026-12-31');
  expect(p[3]!.dueDate).toBe('2027-01-20');
});

test('a due date landing on a weekend or holiday rolls to the next working day', () => {
  // 20 September 2026 is a Sunday -> Monday the 21st.
  expect(filingPeriodsFor(2026, 'monthly')[7]!.dueDate).toBe('2026-09-21'); // August period
});

test('currentFilingPeriod finds the period containing a date', () => {
  expect(currentFilingPeriod('2026-06-15', 'monthly').label).toBe('2026-06');
  expect(currentFilingPeriod('2026-06-15', 'quarterly').label).toBe('2026-Q2');
  expect(currentFilingPeriod('2026-01-01', 'quarterly').fromDate).toBe('2026-01-01');
  expect(currentFilingPeriod('2026-12-31', 'monthly').toDate).toBe('2026-12-31');
});

test('filingPeriodByLabel round-trips every label it produces', () => {
  for (const p of [...filingPeriodsFor(2026, 'monthly'), ...filingPeriodsFor(2026, 'quarterly')]) {
    expect(filingPeriodByLabel(p.label, p.label.includes('Q') ? 'quarterly' : 'monthly')).toEqual(p);
  }
});

test('an unparseable label throws', () => {
  expect(() => filingPeriodByLabel('2026-13', 'monthly')).toThrow();
  expect(() => filingPeriodByLabel('2026-Q5', 'quarterly')).toThrow();
});

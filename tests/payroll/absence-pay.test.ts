import { expect, test } from 'vitest';
import { computeSickPayA, computeVacationPay } from '../../src/payroll/absence-pay.js';

const P = { sickDay23Bp: 7500n, sickDay49Bp: 8000n };
const AVG = 5000n; // 50.00 EUR/day

test('Mon-Fri sick week: day1 0, days2-3 75%, days4-5 80%', () => {
  const r = computeSickPayA({ sickFrom: '2026-07-06', sickTo: '2026-07-10', year: 2026, month: 7, avgDailyCents: AVG, ...P });
  // Mon 0 + Tue 37.50 + Wed 37.50 + Thu 40.00 + Fri 40.00
  expect(r.totalCents).toBe(15500n);
  expect(r.days).toHaveLength(5);
  expect(r.days[0]).toEqual({ date: '2026-07-06', dayIndex: 1, cents: 0n });
  expect(r.days[1]).toEqual({ date: '2026-07-07', dayIndex: 2, cents: 3750n });
  expect(r.days[4]).toEqual({ date: '2026-07-10', dayIndex: 5, cents: 4000n });
});

test('weekend days advance the index but are not paid', () => {
  // Fri Jul 3 (idx1, 0) .. Wed Jul 8; Sat/Sun skipped; Mon=idx4 80%
  const r = computeSickPayA({ sickFrom: '2026-07-03', sickTo: '2026-07-08', year: 2026, month: 7, avgDailyCents: AVG, ...P });
  expect(r.days.map((d) => d.date)).toEqual(['2026-07-03', '2026-07-06', '2026-07-07', '2026-07-08']);
  expect(r.totalCents).toBe(0n + 4000n + 4000n + 4000n);
});

test('cross-month absence: only the requested month is paid, index continues', () => {
  // Sick Jun 29 (Mon, idx1) .. Jul 3; July sees idx3..idx5
  const r = computeSickPayA({ sickFrom: '2026-06-29', sickTo: '2026-07-03', year: 2026, month: 7, avgDailyCents: AVG, ...P });
  expect(r.days.map((d) => d.dayIndex)).toEqual([3, 4, 5]); // Jul 1 (Wed) = calendar day 3
  expect(r.totalCents).toBe(3750n + 4000n + 4000n);
});

test('days past 9 are never employer-paid', () => {
  const r = computeSickPayA({ sickFrom: '2026-07-01', sickTo: '2026-07-15', year: 2026, month: 7, avgDailyCents: AVG, ...P });
  expect(r.days.every((d) => d.dayIndex <= 9 || d.cents === 0n)).toBe(true);
});

test('vacation pay = overlapping workdays x average daily earnings (doc 3.2 step 5)', () => {
  expect(computeVacationPay({ from: '2026-07-13', to: '2026-07-24', year: 2026, month: 7, avgDailyCents: AVG }))
    .toBe(50000n); // 10 workdays x 50.00
  expect(computeVacationPay({ from: '2026-06-29', to: '2026-07-03', year: 2026, month: 7, avgDailyCents: AVG }))
    .toBe(15000n); // Jul 1-3
});

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee, importOpeningHistory } from '../../src/payroll/employees.js';
import { computeAverageEarnings } from '../../src/payroll/average-earnings.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function makeEmp(hiredOn = '2025-01-02') {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, {
    firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'X',
    contractNo: 'DL-1', contractDate: hiredOn, contractType: 'indefinite',
    wageType: 'monthly', wage: '1000.00', hiredOn,
    openingVacationDays: '0', openingBalanceDate: '2026-01-01',
  }));
  return { t, id };
}

test('6 full months before the event, from opening history', async () => {
  const { t, id } = await makeEmp();
  await withTenant(t, (tx) => importOpeningHistory(tx, t, id, [
    { year: 2026, month: 1, avgBaseGross: '1000.00', workedDays: 21 },
    { year: 2026, month: 2, avgBaseGross: '1000.00', workedDays: 20 },
    { year: 2026, month: 3, avgBaseGross: '1000.00', workedDays: 22 },
    { year: 2026, month: 4, avgBaseGross: '1300.00', workedDays: 21 },
    { year: 2026, month: 5, avgBaseGross: '1000.00', workedDays: 20 },
    { year: 2026, month: 6, avgBaseGross: '1000.00', workedDays: 21 },
  ]));
  // Event mid-July: window = Jan..Jun (July itself excluded, doc 3.2 step 1)
  const r = await withTenant(t, (tx) => computeAverageEarnings(tx, t, id, '2026-07-15'));
  // 6300.00 / 125 days = 50.40/day
  expect(r.dailyCents).toBe(5040n);
  expect(r.from).toBe('2026-01');
  expect(r.to).toBe('2026-06');
  expect(r.shifted).toBe(false);
  expect(r.totalWorkedDays).toBe(125);
  expect(r.monthsUsed).toHaveLength(6);
  // monthly average = daily x (calendar workdays in window / 6); Jan..Jun 2026 = 22+20+22+22+21+22 = 129 workdays
  expect(r.monthlyCents).toBe(108360n); // divRound(5040 * 129, 6) = 650160/6
});

test('fewer than 6 months since hire uses the actual period (doc 3.2 case 1)', async () => {
  const { t, id } = await makeEmp('2026-04-01');
  await withTenant(t, (tx) => importOpeningHistory(tx, t, id, [
    { year: 2026, month: 4, avgBaseGross: '880.00', workedDays: 22 },
    { year: 2026, month: 5, avgBaseGross: '800.00', workedDays: 20 },
  ]));
  const r = await withTenant(t, (tx) => computeAverageEarnings(tx, t, id, '2026-06-10'));
  expect(r.totalWorkedDays).toBe(42);
  expect(r.dailyCents).toBe(4000n); // 1680.00/42
  expect(r.monthsUsed).toHaveLength(2);
});

test('zero worked days in the window shifts it back (doc 3.2 case 2)', async () => {
  const { t, id } = await makeEmp('2024-01-02');
  await withTenant(t, (tx) => importOpeningHistory(tx, t, id, [
    // worked normally through 2025-06, then long absence with 0-day months
    { year: 2025, month: 5, avgBaseGross: '1050.00', workedDays: 21 },
    { year: 2025, month: 6, avgBaseGross: '1000.00', workedDays: 21 },
    { year: 2025, month: 7, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2025, month: 8, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2025, month: 9, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2025, month: 10, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2025, month: 11, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2025, month: 12, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2026, month: 1, avgBaseGross: '0.00', workedDays: 0 },
    { year: 2026, month: 2, avgBaseGross: '0.00', workedDays: 0 },
  ]));
  const r = await withTenant(t, (tx) => computeAverageEarnings(tx, t, id, '2026-03-05'));
  expect(r.shifted).toBe(true);
  expect(r.to).toBe('2025-06'); // window ends at the last month with worked days
  expect(r.dailyCents).toBe(4881n); // 2050.00/42 = 48.8095 -> 48.81
});

test('no history at all: clear error naming the fix', async () => {
  const { t, id } = await makeEmp();
  await expect(withTenant(t, (tx) => computeAverageEarnings(tx, t, id, '2026-07-15')))
    .rejects.toThrow(/opening history/i);
});

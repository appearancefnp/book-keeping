import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee, updateEmployee } from '../../src/payroll/employees.js';
import { addAbsence } from '../../src/payroll/inputs.js';
import { vacationBalanceHundredths, recomputeAccrual } from '../../src/payroll/accrual.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function makeEmp(overrides: Record<string, string> = {}) {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, {
    firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'X',
    contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite',
    wageType: 'monthly', wage: '1000.00', hiredOn: '2026-01-02',
    openingVacationDays: '5', openingBalanceDate: '2026-01-31', ...overrides,
  }));
  return { t, id };
}

test('day balance: opening + 1.67/month - used vacation workdays', async () => {
  const { t, id } = await makeEmp();
  // Feb..Jul 2026 = 6 accrual months after the opening month; one 5-workday vacation in June
  await withTenant(t, (tx) => addAbsence(tx, t, {
    employeeId: id, type: 'vacation', dateFrom: '2026-06-01', dateTo: '2026-06-05',
  }));
  const bal = await withTenant(t, (tx) => vacationBalanceHundredths(tx, t, id, 2026, 7));
  // 5.00 + 6x1.67 - 5 = 10.02 days
  expect(bal).toBe(1002n);
});

test('vacation used before the opening date does not double-count', async () => {
  const { t, id } = await makeEmp();
  await withTenant(t, (tx) => addAbsence(tx, t, {
    employeeId: id, type: 'vacation', dateFrom: '2026-01-05', dateTo: '2026-01-09',
  }));
  const bal = await withTenant(t, (tx) => vacationBalanceHundredths(tx, t, id, 2026, 2));
  // opening 5.00 already reflects January; +1.67 for Feb only
  expect(bal).toBe(667n);
});

test('financial accrual: balance x avg daily + employer VSAOI; delta vs previous snapshot', async () => {
  const { t, id } = await makeEmp();
  const first = await withTenant(t, (tx) => recomputeAccrual(tx, t, {
    employeeId: id, year: 2026, month: 2, avgDailyCents: 5000n, employerBp: 2359n,
  }));
  // balance Feb = 5 + 1.67 = 6.67 days -> 333.50; VSAOI 78.67 (23.59% of 333.50 = 78.6727 -> 78.67)
  expect(first.balanceHundredths).toBe(667n);
  expect(first.accrualCents).toBe(33350n);
  expect(first.vsaoiCents).toBe(7867n);
  expect(first.deltaCents).toBe(33350n);       // no previous snapshot
  expect(first.deltaVsaoiCents).toBe(7867n);

  const second = await withTenant(t, (tx) => recomputeAccrual(tx, t, {
    employeeId: id, year: 2026, month: 3, avgDailyCents: 5000n, employerBp: 2359n,
  }));
  // balance Mar = 5 + 2x1.67 = 8.34 -> 417.00; delta = 417.00-333.50 = 83.50
  expect(second.accrualCents).toBe(41700n);
  expect(second.deltaCents).toBe(8350n);
});

test('terminated employee: accrual snaps to zero, delta releases the liability', async () => {
  const { t, id } = await makeEmp();
  await withTenant(t, (tx) => recomputeAccrual(tx, t, {
    employeeId: id, year: 2026, month: 2, avgDailyCents: 5000n, employerBp: 2359n,
  }));
  await withTenant(t, (tx) => updateEmployee(tx, t, id, { terminatedOn: '2026-03-15' }));
  const final = await withTenant(t, (tx) => recomputeAccrual(tx, t, {
    employeeId: id, year: 2026, month: 3, avgDailyCents: 5000n, employerBp: 2359n,
  }));
  expect(final.accrualCents).toBe(0n);
  expect(final.deltaCents).toBe(-33350n); // release of the February accrual
});

test('negative balance (vacation taken in advance) accrues zero, not negative', async () => {
  const { t, id } = await makeEmp({ openingVacationDays: '0', openingBalanceDate: '2026-01-31' });
  await withTenant(t, (tx) => addAbsence(tx, t, {
    employeeId: id, type: 'vacation', dateFrom: '2026-02-02', dateTo: '2026-02-13',
  }));
  const r = await withTenant(t, (tx) => recomputeAccrual(tx, t, {
    employeeId: id, year: 2026, month: 2, avgDailyCents: 5000n, employerBp: 2359n,
  }));
  expect(r.balanceHundredths).toBe(167n - 1000n); // 1.67 - 10 used
  expect(r.accrualCents).toBe(0n);                // doc 3.6: no accrual for 0/negative
});

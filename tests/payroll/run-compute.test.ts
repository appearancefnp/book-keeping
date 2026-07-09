import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee, setMonthlyTaxStatus, importOpeningHistory } from '../../src/payroll/employees.js';
import { addAbsence, addPayComponent } from '../../src/payroll/inputs.js';
import { openRun, computeRun, getRunWithItems, listRuns } from '../../src/payroll/run.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const EMP = {
  firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'X',
  contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite' as const,
  wageType: 'monthly' as const, wage: '1000.00', hiredOn: '2026-01-02',
  openingVacationDays: '0', openingBalanceDate: '2026-01-02',
};

test('monthly employee, full July 2026, 300 bonus: whole item verified', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  await withTenant(t, async (tx) => {
    await setMonthlyTaxStatus(tx, t, emp, { year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0 });
    await addPayComponent(tx, t, { employeeId: emp, year: 2026, month: 7, kind: 'bonus', amount: '300.00' });
  });
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  const run = await withTenant(t, (tx) => getRunWithItems(tx, t, runId));
  expect(run.status).toBe('computed');
  expect(run.items).toHaveLength(1);
  const i = run.items[0]!;
  expect(i.workedDays).toBe(23);
  expect(i.totalWorkDays).toBe(23);
  expect(i.base).toBe('1000.00');
  expect(i.bonus).toBe('300.00');
  expect(i.gross).toBe('1300.00');
  expect(i.avgBaseGross).toBe('1300.00');
  expect(i.vsaoiEmployee).toBe('136.50');   // 10.5%
  expect(i.iin).toBe('156.44');             // (1300-136.50-550)*25.5% = 156.4425
  expect(i.net).toBe('1007.06');
  expect(i.vsaoiEmployer).toBe('306.67');   // 23.59% of 1300 = 306.67
  expect(i.riskDuty).toBe('0.36');
  expect(i.warnings).toContain('avg_earnings_fallback'); // no history yet
  expect(i.explanation.length).toBeGreaterThan(0);
});

test('hourly employee: base = hours x rate', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, {
    ...EMP, personalCode: '010190-22222', contractNo: 'DL-2', wageType: 'hourly', wage: '10.00',
  }));
  await withTenant(t, async (tx) => {
    await setMonthlyTaxStatus(tx, t, emp, { year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0 });
    await addPayComponent(tx, t, { employeeId: emp, year: 2026, month: 7, kind: 'hours_worked', quantity: '100' });
  });
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  const run = await withTenant(t, (tx) => getRunWithItems(tx, t, runId));
  expect(run.items[0]!.base).toBe('1000.00');
});

test('overtime premium from hourly rate of a monthly wage (doc 3.3)', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  await withTenant(t, async (tx) => {
    await setMonthlyTaxStatus(tx, t, emp, { year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0 });
    await addPayComponent(tx, t, { employeeId: emp, year: 2026, month: 7, kind: 'overtime_hours', quantity: '8' });
  });
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  const i = (await withTenant(t, (tx) => getRunWithItems(tx, t, runId))).items[0]!;
  // hourly rate = 1000.00 / (23x8) = 5.43 (half-up); overtime 100% -> 5.43/h; 8h = 43.44
  expect(i.premiums).toBe('43.44');
});

test('vacation mid-month uses the shared average earnings', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  await withTenant(t, async (tx) => {
    await setMonthlyTaxStatus(tx, t, emp, { year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0 });
    await importOpeningHistory(tx, t, emp, [1, 2, 3, 4, 5, 6].map((month) => ({
      year: 2026, month, avgBaseGross: '1000.00', workedDays: 21,
    })));
    await addAbsence(tx, t, { employeeId: emp, type: 'vacation', dateFrom: '2026-07-13', dateTo: '2026-07-24' });
  });
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  const i = (await withTenant(t, (tx) => getRunWithItems(tx, t, runId))).items[0]!;
  // daily avg = 6000/126 = 47.62; vacation = 10 workdays x 47.62 = 476.20
  expect(i.avgDaily).toBe('47.62');
  expect(i.vacationPay).toBe('476.20');
  expect(i.workedDays).toBe(13); // 23 - 10
  expect(i.base).toBe('565.22'); // 1000 x 13/23
  expect(i.warnings).not.toContain('avg_earnings_fallback');
});

test('missing monthly tax status: computes with no reliefs + warning (doc 2.2)', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  const i = (await withTenant(t, (tx) => getRunWithItems(tx, t, runId))).items[0]!;
  expect(i.warnings).toContain('tax_status_missing');
  // no reliefs: IIN = (1000 - 105) * 25.5% = 228.23 (228.225 half-up)
  expect(i.iin).toBe('228.23');
});

test('recompute wipes and re-creates items; duplicate run for a month is rejected', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  await withTenant(t, (tx) => addPayComponent(tx, t, { employeeId: emp, year: 2026, month: 7, kind: 'bonus', amount: '50.00' }));
  await withTenant(t, (tx) => computeRun(tx, t, runId)); // recompute picks up the new bonus
  const run = await withTenant(t, (tx) => getRunWithItems(tx, t, runId));
  expect(run.items).toHaveLength(1);
  expect(run.items[0]!.bonus).toBe('50.00');
  await expect(withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }))).rejects.toThrow(/duplicate key/i);
  expect(await withTenant(t, (tx) => listRuns(tx, t))).toHaveLength(1);
});

test('MUN-regime client is refused (phase 1 stores the flag only)', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, async (tx) => {
    await tx.query(
      `INSERT INTO payroll_settings(client_company_id, mun_regime) VALUES ($1, true)`,
      [t.clientCompanyId]);
  });
  await expect(withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 })))
    .rejects.toThrow(/MUN/);
});

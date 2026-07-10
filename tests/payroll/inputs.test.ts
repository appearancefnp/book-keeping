import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee } from '../../src/payroll/employees.js';
import { addAbsence, listAbsencesOverlapping, addPayComponent, listComponents } from '../../src/payroll/inputs.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function makeEmp() {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, {
    firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'Grāmatvede',
    contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite',
    wageType: 'monthly', wage: '1000.00', hiredOn: '2026-01-02',
    openingVacationDays: '0', openingBalanceDate: '2026-01-02',
  }));
  return { t, id };
}

test('absences: add + list by month overlap', async () => {
  const { t, id } = await makeEmp();
  await withTenant(t, async (tx) => {
    await addAbsence(tx, t, { employeeId: id, type: 'vacation', dateFrom: '2026-07-13', dateTo: '2026-07-24' });
    await addAbsence(tx, t, { employeeId: id, type: 'sick_a', dateFrom: '2026-06-29', dateTo: '2026-07-03' });
    await addAbsence(tx, t, { employeeId: id, type: 'unpaid', dateFrom: '2026-05-04', dateTo: '2026-05-05' });
    const july = await listAbsencesOverlapping(tx, t, id, 2026, 7);
    expect(july).toHaveLength(2); // vacation + the sick spell spilling into July
    expect(july.map((a) => a.type).sort()).toEqual(['sick_a', 'vacation']);
  });
});

test('sick_a longer than 9 calendar days is rejected (split into A+B)', async () => {
  const { t, id } = await makeEmp();
  await expect(withTenant(t, (tx) =>
    addAbsence(tx, t, { employeeId: id, type: 'sick_a', dateFrom: '2026-07-01', dateTo: '2026-07-15' }),
  )).rejects.toThrow(/9 calendar days/);
});

test('pay components: add + list for a month; money vs hour kinds validated', async () => {
  const { t, id } = await makeEmp();
  await withTenant(t, async (tx) => {
    await addPayComponent(tx, t, { employeeId: id, year: 2026, month: 7, kind: 'bonus', amount: '300.00' });
    await addPayComponent(tx, t, { employeeId: id, year: 2026, month: 7, kind: 'overtime_hours', quantity: '8' });
    const rows = await listComponents(tx, t, id, 2026, 7);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === 'bonus')!.amount).toBe('300.00');
    expect(rows.find((r) => r.kind === 'overtime_hours')!.quantity).toBe('8.00');
  });
  await expect(withTenant(t, (tx) =>
    addPayComponent(tx, t, { employeeId: id, year: 2026, month: 7, kind: 'bonus', quantity: '8' }),
  )).rejects.toThrow();
});

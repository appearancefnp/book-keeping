import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createUser } from '../../src/auth/users.js';
import {
  createEmployee, getEmployee, listEmployees, updateEmployee,
  setMonthlyTaxStatus, taxStatusFor, importOpeningHistory,
} from '../../src/payroll/employees.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const EMP = {
  firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'Grāmatvede',
  contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite' as const,
  wageType: 'monthly' as const, wage: '1000.00',
  hiredOn: '2026-01-02', openingVacationDays: '0', openingBalanceDate: '2026-01-02',
};

test('create / get / list / update an employee (audited)', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  const e = await withTenant(t, (tx) => getEmployee(tx, t, id));
  expect(e.firstName).toBe('Anna');
  expect(e.wage).toBe('1000.00');
  expect(e.terminatedOn).toBeNull();

  await withTenant(t, (tx) => updateEmployee(tx, t, id, { wage: '1200.00' }));
  const e2 = await withTenant(t, (tx) => getEmployee(tx, t, id));
  expect(e2.wage).toBe('1200.00');

  const all = await withTenant(t, (tx) => listEmployees(tx, t));
  expect(all).toHaveLength(1);
});

test('rejects duplicate personal code in the same company', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  await expect(withTenant(t, (tx) => createEmployee(tx, t, { ...EMP, contractNo: 'DL-2' })))
    .rejects.toThrow(/duplicate key/i);
});

test('userId + iban: set on create, read back, dup-link rejected, clear + relink works', async () => {
  const t = ctx(await makeFirmAndClient());
  const userA = await createUser({ firmId: t.firmId, email: 'a@t.lv', password: 'password123', role: 'employee' });
  const userB = await createUser({ firmId: t.firmId, email: 'b@t.lv', password: 'password123', role: 'employee' });

  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, {
    ...EMP, userId: userA.id, iban: 'LV80BANK0000435195001',
  }));
  const e = await withTenant(t, (tx) => getEmployee(tx, t, id));
  expect(e.userId).toBe(userA.id);
  expect(e.iban).toBe('LV80BANK0000435195001');

  // Linking a second employee of the same client to the same user violates the partial unique index.
  await expect(withTenant(t, (tx) => createEmployee(tx, t, {
    ...EMP, contractNo: 'DL-2', personalCode: '020290-54321', userId: userA.id,
  }))).rejects.toThrow(/duplicate key/i);

  // Clearing the link works.
  await withTenant(t, (tx) => updateEmployee(tx, t, id, { userId: null }));
  const e2 = await withTenant(t, (tx) => getEmployee(tx, t, id));
  expect(e2.userId).toBeNull();

  // Relinking to a different user + updating IBAN (trimmed) via update.
  await withTenant(t, (tx) => updateEmployee(tx, t, id, { userId: userB.id, iban: '  LV99BANK0000000001  ' }));
  const e3 = await withTenant(t, (tx) => getEmployee(tx, t, id));
  expect(e3.userId).toBe(userB.id);
  expect(e3.iban).toBe('LV99BANK0000000001');
});

test('monthly tax status: upsert, exact hit, stale fallback, missing', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));

  await withTenant(t, (tx) => setMonthlyTaxStatus(tx, t, id, {
    year: 2026, month: 5, taxBookActive: true, dependents: 1, disabilityGroup: 0,
  }));
  // upsert same month
  await withTenant(t, (tx) => setMonthlyTaxStatus(tx, t, id, {
    year: 2026, month: 5, taxBookActive: true, dependents: 2, disabilityGroup: 0,
  }));

  const exact = await withTenant(t, (tx) => taxStatusFor(tx, t, id, 2026, 5));
  expect(exact).toEqual({ taxBookActive: true, dependents: 2, disabilityGroup: 0, isPensioner: false, isRepressed: false, stale: false });

  const stale = await withTenant(t, (tx) => taxStatusFor(tx, t, id, 2026, 7));
  expect(stale).toEqual({ taxBookActive: true, dependents: 2, disabilityGroup: 0, isPensioner: false, isRepressed: false, stale: true });

  const missing = await withTenant(t, (tx) => taxStatusFor(tx, t, id, 2026, 4));
  expect(missing).toBeNull();
});

test('opening history import', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  await withTenant(t, (tx) => importOpeningHistory(tx, t, id, [
    { year: 2025, month: 11, avgBaseGross: '950.00', workedDays: 20 },
    { year: 2025, month: 12, avgBaseGross: '950.00', workedDays: 21 },
  ]));
  const rows = await withTenant(t, (tx) =>
    tx.query('SELECT count(*)::int AS n FROM employee_opening_history WHERE employee_id = $1', [id]));
  expect(rows.rows[0].n).toBe(2);
});

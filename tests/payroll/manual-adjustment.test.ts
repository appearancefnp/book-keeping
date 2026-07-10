import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee, setMonthlyTaxStatus } from '../../src/payroll/employees.js';
import { addPayComponent } from '../../src/payroll/inputs.js';
import { openRun, computeRun, getRunWithItems } from '../../src/payroll/run.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const EMP = {
  firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'X',
  contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite' as const,
  wageType: 'monthly' as const, wage: '1000.00', hiredOn: '2026-01-02',
  openingVacationDays: '0', openingBalanceDate: '2026-01-02',
};

test('a manual adjustment with a reason is audited and folded in on recompute (instr. 5)', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, EMP));
  await withTenant(t, (tx) => setMonthlyTaxStatus(tx, t, emp, {
    year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0,
  }));

  // First run — clean.
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  expect((await withTenant(t, (tx) => getRunWithItems(tx, t, runId))).items[0]!.bonus).toBe('0.00');

  // Manual correction with a mandatory reason, then recompute.
  await withTenant(t, (tx) => addPayComponent(tx, t, {
    employeeId: emp, year: 2026, month: 7, kind: 'bonus', amount: '120.00',
    note: 'Manuāla korekcija: aizmirsta prēmija',
  }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  expect((await withTenant(t, (tx) => getRunWithItems(tx, t, runId))).items[0]!.bonus).toBe('120.00');

  // The reason is in the audit trail.
  const audit = await withTenant(t, (tx) => tx.query(
    `SELECT after FROM audit_log WHERE client_company_id = $1 AND entity_type = 'pay_component'`,
    [t.clientCompanyId]));
  expect(JSON.stringify(audit.rows[0].after)).toContain('aizmirsta prēmija');
});

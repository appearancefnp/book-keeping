import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee, getEmployee } from '../../src/payroll/employees.js';
import { listAbsencesOverlapping, listComponents } from '../../src/payroll/inputs.js';
import { createOrder, approveOrder, getOrder, listOrders } from '../../src/payroll/orders.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function makeTwoEmps() {
  const t = ctx(await makeFirmAndClient());
  const mk = (pc: string, cn: string) => withTenant(t, (tx) => createEmployee(tx, t, {
    firstName: 'A', lastName: pc, personalCode: pc, position: 'X',
    contractNo: cn, contractDate: '2026-01-02', contractType: 'indefinite',
    wageType: 'monthly', wage: '1000.00', hiredOn: '2026-01-02',
    openingVacationDays: '0', openingBalanceDate: '2026-01-02',
  }));
  const a = await mk('010190-11111', 'DL-1');
  const b = await mk('010190-22222', 'DL-2');
  return { t, a: a.id, b: b.id };
}

test('bonus order for two employees creates a component each on approval', async () => {
  const { t, a, b } = await makeTwoEmps();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'bonus', employeeIds: [a, b], amount: '300.00',
    effectiveDate: '2026-07-15', reason: 'Jūlija prēmija nodaļai',
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));
  await withTenant(t, async (tx) => {
    for (const emp of [a, b]) {
      const comps = await listComponents(tx, t, emp, 2026, 7);
      expect(comps).toHaveLength(1);
      expect(comps[0]!.kind).toBe('bonus');
      expect(comps[0]!.amount).toBe('300.00');
      expect(comps[0]!.sourceOrderId).toBe(id);
    }
  });
  const o = await withTenant(t, (tx) => getOrder(tx, t, id));
  expect(o.status).toBe('approved');
});

test('vacation order creates the absence on approval', async () => {
  const { t, a } = await makeTwoEmps();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'vacation', employeeIds: [a], dateFrom: '2026-07-13', dateTo: '2026-07-24',
    effectiveDate: '2026-07-13', reason: 'Ikgadējais atvaļinājums',
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));
  const abs = await withTenant(t, (tx) => listAbsencesOverlapping(tx, t, a, 2026, 7));
  expect(abs).toHaveLength(1);
  expect(abs[0]!.type).toBe('vacation');
  expect(abs[0]!.sourceOrderId).toBe(id);
});

test('wage_change order updates the employee wage on approval', async () => {
  const { t, a } = await makeTwoEmps();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'wage_change', employeeIds: [a], amount: '1200.00',
    effectiveDate: '2026-08-01', reason: 'Algas paaugstinājums',
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));
  const e = await withTenant(t, (tx) => getEmployee(tx, t, a));
  expect(e.wage).toBe('1200.00');
});

test('an approved order cannot be approved twice', async () => {
  const { t, a } = await makeTwoEmps();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'bonus', employeeIds: [a], amount: '100.00',
    effectiveDate: '2026-07-15', reason: 'X',
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));
  await expect(withTenant(t, (tx) => approveOrder(tx, t, id))).rejects.toThrow(/not a draft/);
});

test('order archive: list with type filter', async () => {
  const { t, a } = await makeTwoEmps();
  await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'bonus', employeeIds: [a], amount: '100.00', effectiveDate: '2026-07-15', reason: 'X',
  }));
  await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'vacation', employeeIds: [a], dateFrom: '2026-08-03', dateTo: '2026-08-07',
    effectiveDate: '2026-08-03', reason: 'Y',
  }));
  const bonuses = await withTenant(t, (tx) => listOrders(tx, t, { orderType: 'bonus' }));
  expect(bonuses).toHaveLength(1);
  const all = await withTenant(t, (tx) => listOrders(tx, t, {}));
  expect(all).toHaveLength(2);
});

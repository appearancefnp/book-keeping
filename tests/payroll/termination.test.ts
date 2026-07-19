import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createEmployee, getEmployee, setMonthlyTaxStatus, importOpeningHistory } from '../../src/payroll/employees.js';
import { listComponents } from '../../src/payroll/inputs.js';
import { createOrder, approveOrder } from '../../src/payroll/orders.js';
import { severanceMonthsFor } from '../../src/payroll/termination.js';
import { openRun, computeRun, getRunWithItems } from '../../src/payroll/run.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('severance months by tenure (doc 3.8 table)', () => {
  expect(severanceMonthsFor('2023-01-02', '2026-07-31')).toBe(1); // 3 years
  expect(severanceMonthsFor('2020-03-01', '2026-07-31')).toBe(2); // 6 years
  expect(severanceMonthsFor('2012-07-31', '2026-07-31')).toBe(3); // exactly 14 years
  expect(severanceMonthsFor('2004-01-02', '2026-07-31')).toBe(4); // 22 years
  expect(severanceMonthsFor('2021-08-01', '2026-07-31')).toBe(1); // 4y 364d -> under 5
});

async function setup() {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, {
    firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'X',
    contractNo: 'DL-1', contractDate: '2020-03-01', contractType: 'indefinite',
    wageType: 'monthly', wage: '1000.00', hiredOn: '2020-03-01',
    openingVacationDays: '10', openingBalanceDate: '2026-06-30',
  }));
  await withTenant(t, async (tx) => {
    await setMonthlyTaxStatus(tx, t, emp, { year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0 });
    await importOpeningHistory(tx, t, emp, [1, 2, 3, 4, 5, 6].map((month) => ({
      year: 2026, month, avgBaseGross: '1000.00', workedDays: 21,
    })));
  });
  return { t, emp };
}

test('termination order approval: sets terminated_on, creates compensation + severance', async () => {
  const { t, emp } = await setup();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'termination', employeeIds: [emp],
    dateFrom: '2026-07-31', dateTo: '2026-07-31', effectiveDate: '2026-07-31',
    reason: 'Darbinieka uzteikums (DL 100)', payload: { severance: true },
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));

  const e = await withTenant(t, (tx) => getEmployee(tx, t, emp));
  expect(e.terminatedOn).toBe('2026-07-31');

  const comps = await withTenant(t, (tx) => listComponents(tx, t, emp, 2026, 7));
  const byKind = (k: string) => comps.find((c) => c.kind === k)!;
  // daily avg 6000/126 = 47.62; balance = 10 + 1.67 = 11.67 days -> 555.73
  expect(byKind('other_taxable').amount).toBe('555.73');
  // monthly avg = 47.62 x (122 window workdays / 6) = 968.27; 6y tenure -> 2 months = 1936.54
  // (Jan..Jun 2026 window: Jan 1 New Year, Apr 3 Good Friday, Apr 6 Easter Monday,
  // May 1 Labour Day, May 4 Restoration of Independence, Jun 23 Līgo, Jun 24 Jāņi)
  expect(byKind('severance_exempt').amount).toBe('1936.54');
});

test('the final run combines wage + compensation + exempt severance in one item', async () => {
  const { t, emp } = await setup();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'termination', employeeIds: [emp],
    dateFrom: '2026-07-31', dateTo: '2026-07-31', effectiveDate: '2026-07-31',
    reason: 'X', payload: { severance: true },
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  const i = (await withTenant(t, (tx) => getRunWithItems(tx, t, runId))).items[0]!;
  expect(i.base).toBe('1000.00');            // worked through 2026-07-31
  expect(i.otherTaxable).toBe('555.73');     // vacation compensation — taxed
  // severance = 968.27/mo x 2 (6y tenure) with Jan..Jun 2026 window holiday-adjusted
  // (Jan 1, Apr 3 Good Friday, Apr 6 Easter Monday, May 1, May 4, Jun 23 Līgo, Jun 24 Jāņi)
  expect(i.severanceExempt).toBe('1936.54'); // severance — payout only
  expect(i.gross).toBe('1555.73');           // severance NOT in gross
  const netCents = BigInt(i.net.replace('.', ''));
  expect(BigInt(i.payout.replace('.', ''))).toBe(netCents + 193654n);
});

test('termination without severance entitlement creates no severance component', async () => {
  const { t, emp } = await setup();
  const { id } = await withTenant(t, (tx) => createOrder(tx, t, {
    orderType: 'termination', employeeIds: [emp],
    dateFrom: '2026-07-31', dateTo: '2026-07-31', effectiveDate: '2026-07-31',
    reason: 'X', payload: { severance: false },
  }));
  await withTenant(t, (tx) => approveOrder(tx, t, id));
  const comps = await withTenant(t, (tx) => listComponents(tx, t, emp, 2026, 7));
  expect(comps.find((c) => c.kind === 'severance_exempt')).toBeUndefined();
});

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createEmployee, setMonthlyTaxStatus } from '../../src/payroll/employees.js';
import { openRun, computeRun, approveRun, getRun } from '../../src/payroll/run.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const t = ctx(await makeFirmAndClient());
  const { id: emp } = await withTenant(t, (tx) => createEmployee(tx, t, {
    firstName: 'Anna', lastName: 'Ozola', personalCode: '010190-12345', position: 'X',
    contractNo: 'DL-1', contractDate: '2026-01-02', contractType: 'indefinite',
    wageType: 'monthly', wage: '1000.00', hiredOn: '2026-01-02',
    openingVacationDays: '0', openingBalanceDate: '2026-06-30',
  }));
  await withTenant(t, async (tx) => {
    await openPeriod(tx, t, { year: 2026, month: 7 });
    await setMonthlyTaxStatus(tx, t, emp, { year: 2026, month: 7, taxBookActive: true, dependents: 0, disabilityGroup: 0 });
  });
  const { id: runId } = await withTenant(t, (tx) => openRun(tx, t, { year: 2026, month: 7 }));
  await withTenant(t, (tx) => computeRun(tx, t, runId));
  return { t, emp, runId };
}

test('approval posts the doc-3.4 wage entry and the doc-3.7 accrual entry', async () => {
  const { t, runId } = await setup();
  await withTenant(t, (tx) => approveRun(tx, t, runId));

  const run = await withTenant(t, (tx) => getRun(tx, t, runId));
  expect(run.status).toBe('approved');

  await withTenant(t, async (tx) => {
    // ORDER BY memo, not created_at: both entries share the transaction's now().
    // 'Alga ...' sorts before 'Atvaļinājuma uzkrājums ...'.
    const entries = await tx.query(
      `SELECT je.id, je.memo FROM journal_entries je WHERE je.client_company_id = $1 ORDER BY je.memo`,
      [t.clientCompanyId]);
    expect(entries.rows).toHaveLength(2); // wage entry + accrual entry
    expect(entries.rows[0].memo).toMatch(/Alga 2026-07/);
    expect(entries.rows[1].memo).toMatch(/uzkrājums/i);

    // Wage entry: 1000 gross, tax status active, 0 dependents:
    // VSAOI emp 105.00, IIN (1000-105-550)*25.5% = 87.98, employer VSAOI 235.90, risk duty 0.36
    const lines = await tx.query(
      `SELECT a.code, jl.debit::text, jl.credit::text
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.entry_id = $1 ORDER BY a.code, jl.debit DESC`,
      [entries.rows[0].id]);
    const find = (code: string, side: 'debit' | 'credit') =>
      lines.rows.filter((l: { code: string; debit: string; credit: string }) => l.code === code && l[side] !== '0.00');
    expect(find('7210', 'debit')[0].debit).toBe('1000.00');
    expect(find('5610', 'credit')[0].credit).toBe('1000.00');
    expect(find('7310', 'debit')[0].debit).toBe('235.90');
    expect(find('57221', 'credit').map((l: { credit: string }) => l.credit).sort()).toEqual(['105.00', '235.90']);
    expect(find('7330', 'debit')[0].debit).toBe('0.36');
    expect(find('5723', 'credit')[0].credit).toBe('0.36');
    expect(find('5720', 'credit')[0].credit).toBe('87.98');
    expect(find('5610', 'debit').map((l: { debit: string }) => l.debit).sort()).toEqual(['105.00', '87.98']);

    // Accrual entry: July balance = 1.67 days x avg daily (fallback 1000/23 = 43.48) = 72.61;
    // VSAOI 23.59% = 17.13
    const acc = await tx.query(
      `SELECT a.code, jl.debit::text, jl.credit::text
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.entry_id = $1`, [entries.rows[1].id]);
    const accBy = (code: string) => acc.rows.find((l: { code: string }) => l.code === code)!;
    expect(accBy('5411').credit).toBe('72.61');
    expect(accBy('5412').credit).toBe('17.13');
  });
});

test('approve requires computed status; double approve and recompute-after-approve fail', async () => {
  const { t, runId } = await setup();
  await withTenant(t, (tx) => approveRun(tx, t, runId));
  await expect(withTenant(t, (tx) => approveRun(tx, t, runId))).rejects.toThrow(/not computed/);
  await expect(withTenant(t, (tx) => computeRun(tx, t, runId))).rejects.toThrow(/approved/);
});

test('approval fails when the accounting period is closed (postEntry guard)', async () => {
  const { t, runId } = await setup();
  await withTenant(t, async (tx) => {
    await tx.query(`UPDATE accounting_periods SET status='closed' WHERE client_company_id=$1`, [t.clientCompanyId]);
  });
  await expect(withTenant(t, (tx) => approveRun(tx, t, runId))).rejects.toThrow(/closed period/);
});

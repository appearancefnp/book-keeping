import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { getPayrollSettings, ensurePayrollAccounts } from '../../src/payroll/settings.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('getPayrollSettings creates a default row on first read', async () => {
  const t = ctx(await makeFirmAndClient());
  const s = await withTenant(t, (tx) => getPayrollSettings(tx, t));
  expect(s.munRegime).toBe(false);
  expect(s.accWageExpense).toBe('7210');
  expect(s.accWagesPayable).toBe('5610');
  expect(s.accVacationAccrualLiability).toBe('5411');
});

test('ensurePayrollAccounts creates missing accounts once, idempotently', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, async (tx) => {
    await ensurePayrollAccounts(tx, t);
    await ensurePayrollAccounts(tx, t); // second call must not throw
    const res = await tx.query(
      "SELECT code, type FROM accounts WHERE client_company_id = $1 ORDER BY code",
      [t.clientCompanyId],
    );
    const codes = res.rows.map((r: { code: string }) => r.code);
    for (const c of ['5411', '5412', '5610', '5620', '5720', '5723', '57221', '7210', '7230', '7310', '7330']) {
      expect(codes).toContain(c);
    }
    expect(res.rows.find((r: { code: string; type: string }) => r.code === '7210')!.type).toBe('expense');
    expect(res.rows.find((r: { code: string; type: string }) => r.code === '5610')!.type).toBe('liability');
  });
});

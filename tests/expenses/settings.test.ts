import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { getExpenseSettings, setMileageRate } from '../../src/expenses/settings.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('getExpenseSettings creates the default row (30) on first read', async () => {
  const t = ctx(await makeFirmAndClient());
  const s = await withTenant(t, (tx) => getExpenseSettings(tx, t));
  expect(s.mileageRateCentsPerKm).toBe('30');

  const raw = await withTenant(t, (tx) => tx.query(
    `SELECT count(*)::int AS n FROM expense_settings WHERE client_company_id = $1`, [t.clientCompanyId],
  ));
  expect(raw.rows[0].n).toBe(1);

  // Idempotent: a second read doesn't create a duplicate row or change the value.
  const s2 = await withTenant(t, (tx) => getExpenseSettings(tx, t));
  expect(s2.mileageRateCentsPerKm).toBe('30');
});

test('setMileageRate updates, audits, rejects zero/negative', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => setMileageRate(tx, t, '35'));
  const s = await withTenant(t, (tx) => getExpenseSettings(tx, t));
  expect(s.mileageRateCentsPerKm).toBe('35');

  const audit = await withTenant(t, (tx) => tx.query(
    `SELECT action, entity_type AS "entityType" FROM audit_log WHERE entity_type = 'expense_settings' ORDER BY created_at DESC LIMIT 1`,
  ));
  expect(audit.rowCount).toBe(1);
  expect(audit.rows[0].action).toBe('update');

  await expect(withTenant(t, (tx) => setMileageRate(tx, t, '0'))).rejects.toThrow(/greater than zero/i);
  await expect(withTenant(t, (tx) => setMileageRate(tx, t, '-5'))).rejects.toThrow(/greater than zero/i);
});

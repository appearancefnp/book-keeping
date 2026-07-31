import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { getVatSettings, setVatSettings } from '../../src/tax/vat-settings.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('defaults to monthly with no VAT number on first read', async () => {
  const t = await makeFirmAndClient();
  const s = await withTenant(ctx(t), (tx) => getVatSettings(tx, ctx(t)));
  expect(s).toEqual({ vatNo: null, periodicity: 'monthly' });
});

test('stores and returns the VAT number and periodicity', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => setVatSettings(tx, ctx(t), { vatNo: 'LV40100000000', periodicity: 'quarterly' }));
  const s = await withTenant(ctx(t), (tx) => getVatSettings(tx, ctx(t)));
  expect(s).toEqual({ vatNo: 'LV40100000000', periodicity: 'quarterly' });
});

test('rejects an unknown periodicity', async () => {
  const t = await makeFirmAndClient();
  await expect(withTenant(ctx(t), (tx) =>
    setVatSettings(tx, ctx(t), { vatNo: null, periodicity: 'annual' as never })))
    .rejects.toThrow(/periodicity/i);
});

test('writes an audit record', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => setVatSettings(tx, ctx(t), { vatNo: 'LV40100000000', periodicity: 'monthly' }));
  const rows = await withTenant(ctx(t), (tx) => tx.query(
    `SELECT action, entity_type FROM audit_log WHERE client_company_id = $1 AND entity_type = 'vat_settings'`,
    [t.clientCompanyId]));
  expect(rows.rowCount).toBe(1);
  expect(rows.rows[0]!.action).toBe('update');
});

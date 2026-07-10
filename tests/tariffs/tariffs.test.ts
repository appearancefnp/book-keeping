import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { setTariff, getCurrentTariff, listCurrentTariffsForFirm } from '../../src/tariffs/tariffs.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('setTariff inserts a row and writes an audit entry', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  const { id } = await withTenant(c, (tx) =>
    setTariff(tx, c, { monthlyAmountCents: 150000n, currency: 'EUR', vatRate: '21', effectiveFrom: '2026-01-01' }),
  );
  expect(id).toBeTruthy();
  const audit = await withTenant(c, (tx) =>
    tx.query(`SELECT action, entity_type, entity_id FROM audit_log WHERE entity_type = 'tariff'`),
  );
  expect(audit.rowCount).toBe(1);
  expect(audit.rows[0].entity_id).toBe(id);
});

test('getCurrentTariff returns the greatest effective_from <= asOf, or null', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await setTariff(tx, c, { monthlyAmountCents: 100000n, currency: 'EUR', vatRate: '21', effectiveFrom: '2026-01-01' });
    await setTariff(tx, c, { monthlyAmountCents: 120000n, currency: 'EUR', vatRate: '21', effectiveFrom: '2026-06-01' });
  });
  const mar = await withTenant(c, (tx) => getCurrentTariff(tx, c, '2026-03-01'));
  expect(mar?.monthlyAmountCents).toBe('100000');
  const jul = await withTenant(c, (tx) => getCurrentTariff(tx, c, '2026-07-01'));
  expect(jul?.monthlyAmountCents).toBe('120000');
  const before = await withTenant(c, (tx) => getCurrentTariff(tx, c, '2025-12-01'));
  expect(before).toBeNull();
});

test('same effective_from upserts (corrects that day) rather than duplicating', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await setTariff(tx, c, { monthlyAmountCents: 100000n, currency: 'EUR', vatRate: '21', effectiveFrom: '2026-01-01' });
    await setTariff(tx, c, { monthlyAmountCents: 110000n, currency: 'EUR', vatRate: '21', effectiveFrom: '2026-01-01' });
  });
  const cur = await withTenant(c, (tx) => getCurrentTariff(tx, c, '2026-02-01'));
  expect(cur?.monthlyAmountCents).toBe('110000');
});

test('listCurrentTariffsForFirm is firm-scoped, one current row per client, null for none', async () => {
  const a = await makeFirmAndClient('Firm A Client');
  const b = await makeFirmAndClient('Firm B Client'); // different firm
  const ca = ctx(a);
  await withTenant(ca, (tx) =>
    setTariff(tx, ca, { monthlyAmountCents: 90000n, currency: 'EUR', vatRate: '21', effectiveFrom: '2026-01-01' }),
  );
  const listA = await listCurrentTariffsForFirm(a.firmId, '2026-07-01');
  expect(listA.length).toBe(1);
  expect(listA[0]!.clientCompanyId).toBe(a.clientCompanyId);
  expect(listA[0]!.monthlyAmountCents).toBe('90000');
  // firm A's list must NOT contain firm B's client (guards the no-RLS decision)
  expect(listA.some((r) => r.clientCompanyId === b.clientCompanyId)).toBe(false);
  // firm B's client has no tariff → appears with null fields
  const listB = await listCurrentTariffsForFirm(b.firmId, '2026-07-01');
  expect(listB.length).toBe(1);
  expect(listB[0]!.monthlyAmountCents).toBeNull();
});

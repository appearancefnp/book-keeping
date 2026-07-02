import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { openPeriod, closePeriod, periodStatusFor } from '../../src/ledger/periods.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('an unopened period reports status "none"', async () => {
  const t = await makeFirmAndClient();
  const status = await withTenant(ctx(t), (tx) => periodStatusFor(tx, ctx(t), '2026-03-15'));
  expect(status).toBe('none');
});

test('opening then closing a period changes its status', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
  });
  expect(await withTenant(ctx(t), (tx) => periodStatusFor(tx, ctx(t), '2026-03-15'))).toBe('open');

  await withTenant(ctx(t), (tx) => closePeriod(tx, ctx(t), { year: 2026, month: 3 }));
  expect(await withTenant(ctx(t), (tx) => periodStatusFor(tx, ctx(t), '2026-03-15'))).toBe('closed');
});

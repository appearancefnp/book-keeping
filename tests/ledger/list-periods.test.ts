import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { openPeriod, closePeriod, listPeriods } from '../../src/ledger/periods.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('lists periods newest-first with status', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await openPeriod(tx, ctx(t), { year: 2026, month: 1 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 2 });
    await closePeriod(tx, ctx(t), { year: 2026, month: 1 });
  });
  const periods = await withTenant(ctx(t), (tx) => listPeriods(tx, ctx(t)));
  expect(periods).toEqual([
    { year: 2026, month: 2, status: 'open' },
    { year: 2026, month: 1, status: 'closed' },
  ]);
});

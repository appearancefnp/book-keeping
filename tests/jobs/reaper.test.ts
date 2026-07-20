import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker } from '../../src/db/pool.js';
import { setDunningPolicy } from '../../src/dunning/policy.js';
import { reapOnce } from '../../src/jobs/reapers.js';
import '../../src/jobs/register.js'; // registers reapDunning

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('reapOnce runs registered reapers and seeds for an enabled dead chain', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => setDunningPolicy(tx, t, { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' }));
  const { seeded } = await reapOnce({ now: new Date('2026-05-10T09:00:00Z') });
  expect(seeded).toBe(1);
  const jobs = await withWorker((tx) => tx.query(`SELECT type, status FROM jobs`));
  expect(jobs.rows).toEqual([{ type: 'dunning_run', status: 'pending' }]);
});

test('reapOnce is idempotent across repeated sweeps', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => setDunningPolicy(tx, t, { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' }));
  const now = new Date('2026-05-10T09:00:00Z');
  await reapOnce({ now });
  const second = await reapOnce({ now });
  expect(second.seeded).toBe(0);
  const n = await withWorker((tx) => tx.query(`SELECT count(*)::int AS n FROM jobs`));
  expect(n.rows[0].n).toBe(1);
});

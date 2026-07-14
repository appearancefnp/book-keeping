import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { setup } from '../receivables/helpers.js';
import { getDunningPolicy, setDunningPolicy, listStages, setStages, DEFAULT_STAGES } from '../../src/dunning/policy.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('GET-shape: policy+stages read together return defaults for a fresh client', async () => {
  const { cid } = await setup();
  const result = await withTenant(cid, async (tx) => ({
    policy: await getDunningPolicy(tx, cid),
    stages: await listStages(tx, cid),
  }));
  expect(result.policy).toEqual({ enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' });
  expect(result.stages).toEqual(DEFAULT_STAGES);
});

test('PUT-shape: policy + stages are written atomically in one tenant tx', async () => {
  const { cid } = await setup();
  await withTenant(cid, async (tx) => {
    await setDunningPolicy(tx, cid, { enabled: true, lateFeeAnnualBps: 500, lateFeeFlatCents: '0' });
    await setStages(tx, cid, [{ level: 1, daysOverdue: 10 }]);
  });
  const result = await withTenant(cid, async (tx) => ({
    policy: await getDunningPolicy(tx, cid),
    stages: await listStages(tx, cid),
  }));
  expect(result.policy.lateFeeAnnualBps).toBe(500);
  expect(result.stages).toEqual([{ level: 1, daysOverdue: 10 }]);
});

test('validation: negative late-fee bps/flat are rejected', async () => {
  const { cid } = await setup();
  await expect(withTenant(cid, (tx) =>
    setDunningPolicy(tx, cid, { enabled: true, lateFeeAnnualBps: -1, lateFeeFlatCents: '0' })),
  ).rejects.toThrow(/non-negative/i);
  await expect(withTenant(cid, (tx) =>
    setDunningPolicy(tx, cid, { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '-5' })),
  ).rejects.toThrow(/non-negative/i);
});

test('validation: negative stage days_overdue is rejected', async () => {
  const { cid } = await setup();
  await expect(withTenant(cid, (tx) =>
    setStages(tx, cid, [{ level: 1, daysOverdue: -3 }])),
  ).rejects.toThrow(/non-negative/i);
});

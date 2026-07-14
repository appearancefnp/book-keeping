import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { setup } from '../receivables/helpers.js';
import {
  getDunningPolicy, setDunningPolicy, listStages, setStages, DEFAULT_STAGES,
} from '../../src/dunning/policy.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('policy defaults when unconfigured, then round-trips an upsert', async () => {
  const { cid } = await setup();
  const def = await withTenant(cid, (tx) => getDunningPolicy(tx, cid));
  expect(def).toEqual({ enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' });

  await withTenant(cid, (tx) => setDunningPolicy(tx, cid, { enabled: false, lateFeeAnnualBps: 800, lateFeeFlatCents: '500' }));
  const got = await withTenant(cid, (tx) => getDunningPolicy(tx, cid));
  expect(got).toEqual({ enabled: false, lateFeeAnnualBps: 800, lateFeeFlatCents: '500' });

  // second upsert updates in place (PK conflict), does not error/duplicate
  await withTenant(cid, (tx) => setDunningPolicy(tx, cid, { enabled: true, lateFeeAnnualBps: 1200, lateFeeFlatCents: '0' }));
  const got2 = await withTenant(cid, (tx) => getDunningPolicy(tx, cid));
  expect(got2).toEqual({ enabled: true, lateFeeAnnualBps: 1200, lateFeeFlatCents: '0' });
});

test('listStages returns DEFAULT_STAGES until custom stages are set', async () => {
  const { cid } = await setup();
  const def = await withTenant(cid, (tx) => listStages(tx, cid));
  expect(def).toEqual(DEFAULT_STAGES);

  await withTenant(cid, (tx) => setStages(tx, cid, [
    { level: 1, daysOverdue: 7 }, { level: 2, daysOverdue: 30 },
  ]));
  const got = await withTenant(cid, (tx) => listStages(tx, cid));
  expect(got).toEqual([{ level: 1, daysOverdue: 7 }, { level: 2, daysOverdue: 30 }]);

  // replace (not append): setting again fully swaps the set
  await withTenant(cid, (tx) => setStages(tx, cid, [{ level: 1, daysOverdue: 3 }]));
  const got2 = await withTenant(cid, (tx) => listStages(tx, cid));
  expect(got2).toEqual([{ level: 1, daysOverdue: 3 }]);
});

test('setStages rejects non-ascending or duplicate-level stage sets', async () => {
  const { cid } = await setup();
  await expect(withTenant(cid, (tx) => setStages(tx, cid, [
    { level: 1, daysOverdue: 30 }, { level: 2, daysOverdue: 15 },
  ]))).rejects.toThrow(/ascending/i);
  await expect(withTenant(cid, (tx) => setStages(tx, cid, [
    { level: 1, daysOverdue: 5 }, { level: 1, daysOverdue: 10 },
  ]))).rejects.toThrow(/distinct|duplicate/i);
});

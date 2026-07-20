import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker, withSupervisor } from '../../src/db/pool.js';
import { setDunningPolicy } from '../../src/dunning/policy.js';
import { enqueue } from '../../src/jobs/queue.js';
import { reapDunning } from '../../src/dunning/reap.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const NOW = new Date('2026-05-10T09:00:00Z'); // today = 2026-05-10

async function enablePolicy(t: ReturnType<typeof ctx>) {
  await withTenant(t, (tx) => setDunningPolicy(tx, t, { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' }));
}

test('seeds a dunning_run for an enabled client with no live job', async () => {
  const t = ctx(await makeFirmAndClient());
  await enablePolicy(t);
  const { seeded } = await withSupervisor((tx) => reapDunning(tx, { now: NOW }));
  expect(seeded).toBe(1);
  const jobs = await withWorker((tx) => tx.query(`SELECT type, status, dedup_key FROM jobs`));
  expect(jobs.rows).toEqual([{ type: 'dunning_run', status: 'pending', dedup_key: 'dunning:2026-05-10' }]);
});

test('no-op when a live pending job already exists', async () => {
  const t = ctx(await makeFirmAndClient());
  await enablePolicy(t);
  await withTenant(t, (tx) => enqueue(tx, t, { type: 'dunning_run', runAt: NOW, payload: { asOf: '2026-05-10' }, dedupKey: 'dunning:2026-05-10' }));
  const { seeded } = await withSupervisor((tx) => reapDunning(tx, { now: NOW }));
  expect(seeded).toBe(0);
  const jobs = await withWorker((tx) => tx.query(`SELECT count(*)::int AS n FROM jobs`));
  expect(jobs.rows[0].n).toBe(1);
});

test('no-op when a live pending job exists from an earlier day (NOT EXISTS guard, not the unique index)', async () => {
  const t = ctx(await makeFirmAndClient());
  await enablePolicy(t);
  await withTenant(t, (tx) => enqueue(tx, t, { type: 'dunning_run', runAt: new Date('2026-05-09T00:00:00Z'), payload: { asOf: '2026-05-09' }, dedupKey: 'dunning:2026-05-09' }));
  const { seeded } = await withSupervisor((tx) => reapDunning(tx, { now: NOW }));
  expect(seeded).toBe(0);
  const jobs = await withWorker((tx) => tx.query(`SELECT count(*)::int AS n FROM jobs`));
  expect(jobs.rows[0].n).toBe(1);
});

test('no-op when the policy is disabled', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => setDunningPolicy(tx, t, { enabled: false, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' }));
  const { seeded } = await withSupervisor((tx) => reapDunning(tx, { now: NOW }));
  expect(seeded).toBe(0);
});

test('revives a dead chain: only a past failed job exists', async () => {
  const t = ctx(await makeFirmAndClient());
  await enablePolicy(t);
  await withTenant(t, (tx) => enqueue(tx, t, { type: 'dunning_run', runAt: new Date('2026-05-08T00:00:00Z'), payload: { asOf: '2026-05-08' }, dedupKey: 'dunning:2026-05-08' }));
  await withWorker((tx) => tx.query(`UPDATE jobs SET status='failed'`));
  const { seeded } = await withSupervisor((tx) => reapDunning(tx, { now: NOW }));
  expect(seeded).toBe(1);
  const live = await withWorker((tx) => tx.query(`SELECT dedup_key FROM jobs WHERE status='pending'`));
  expect(live.rows).toEqual([{ dedup_key: 'dunning:2026-05-10' }]);
});

test('does not double-seed when today already failed (<=1-day recovery window)', async () => {
  const t = ctx(await makeFirmAndClient());
  await enablePolicy(t);
  await withTenant(t, (tx) => enqueue(tx, t, { type: 'dunning_run', runAt: NOW, payload: { asOf: '2026-05-10' }, dedupKey: 'dunning:2026-05-10' }));
  await withWorker((tx) => tx.query(`UPDATE jobs SET status='failed'`));
  const { seeded } = await withSupervisor((tx) => reapDunning(tx, { now: NOW }));
  expect(seeded).toBe(0);
});

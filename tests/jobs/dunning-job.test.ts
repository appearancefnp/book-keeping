import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker } from '../../src/db/pool.js';
import { setup, issueOpenReceivable } from '../receivables/helpers.js';
import { drainOnce } from '../../src/jobs/worker.js';
import { enqueueDunningRun, nextDay } from '../../src/dunning/schedule.js';
import { setDunningPolicy } from '../../src/dunning/policy.js';
import { enqueue } from '../../src/jobs/queue.js';
import { listTasks } from '../../src/collab/tasks.js';
import { getHandler } from '../../src/jobs/handlers.js';
import '../../src/jobs/register.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });
const LEASE = 5 * 60 * 1000;

test('enqueueDunningRun is idempotent per asOf', async () => {
  const { cid } = await setup();
  const a = await withTenant(cid, (tx) => enqueueDunningRun(tx, cid, { asOf: '2026-03-30' }));
  const b = await withTenant(cid, (tx) => enqueueDunningRun(tx, cid, { asOf: '2026-03-30' }));
  expect(a).toHaveProperty('jobId');
  expect(b).toEqual({ deduped: true });
  const n = await withWorker((tx) => tx.query(`SELECT count(*)::int AS n FROM jobs WHERE type='dunning_run'`));
  expect(n.rows[0].n).toBe(1);
});

test('draining a dunning_run runs dunning and enqueues the next day', async () => {
  const { cid, customerId } = await setup();
  await issueOpenReceivable(cid, customerId, { dueDate: '2026-03-10' }); // overdue by asOf
  await withTenant(cid, (tx) => enqueueDunningRun(tx, cid, { asOf: '2026-03-30' }));

  const res = await drainOnce({ now: new Date(), leaseTimeoutMs: LEASE, limit: 10 });
  expect(res.ran).toBe(1);

  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(1); // a chase task was created

  // The handler enqueued tomorrow's run (deduped on the date).
  const next = await withWorker((tx) => tx.query(
    `SELECT dedup_key FROM jobs WHERE type='dunning_run' AND status='pending'`));
  expect(next.rows.map((r) => r.dedup_key)).toContain('dunning:2026-03-31');
});

test('at-least-once redelivery: running the same dunning_run twice produces one task', async () => {
  const { cid, customerId } = await setup();
  await issueOpenReceivable(cid, customerId, { dueDate: '2026-03-10' });
  const handler = getHandler('dunning_run');
  if (!handler) throw new Error('dunning_run handler not registered');
  // Redeliver the SAME asOf twice. runDunning's event-first ON CONFLICT must dedup the second run.
  await withTenant(cid, (tx) => handler(tx, cid, { asOf: '2026-03-30' }));
  await withTenant(cid, (tx) => handler(tx, cid, { asOf: '2026-03-30' }));
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(1);
});

test('nextDay rolls month and year boundaries (UTC)', () => {
  expect(nextDay('2026-03-31')).toBe('2026-04-01');
  expect(nextDay('2026-12-31')).toBe('2027-01-01');
  expect(nextDay('2026-02-28')).toBe('2026-03-01'); // 2026 is not a leap year
});

test('a disabled policy stops chain perpetuation (no successor job)', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => setDunningPolicy(tx, t, { enabled: false, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' }));
  await withTenant(t, (tx) => enqueue(tx, t, { type: 'dunning_run', runAt: new Date('2026-05-10T00:00:00Z'), payload: { asOf: '2026-05-10' }, dedupKey: 'dunning:2026-05-10' }));
  await drainOnce({ now: new Date('2026-05-10T09:00:00Z'), leaseTimeoutMs: 5 * 60 * 1000, limit: 10 });
  const pending = await withWorker((tx) => tx.query(`SELECT count(*)::int AS n FROM jobs WHERE status='pending'`));
  expect(pending.rows[0].n).toBe(0); // no tomorrow job enqueued
});

test('an enabled policy perpetuates exactly one successor job', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => setDunningPolicy(tx, t, { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' }));
  await withTenant(t, (tx) => enqueue(tx, t, { type: 'dunning_run', runAt: new Date('2026-05-10T00:00:00Z'), payload: { asOf: '2026-05-10' }, dedupKey: 'dunning:2026-05-10' }));
  await drainOnce({ now: new Date('2026-05-10T09:00:00Z'), leaseTimeoutMs: 5 * 60 * 1000, limit: 10 });
  const pending = await withWorker((tx) => tx.query(`SELECT dedup_key FROM jobs WHERE status='pending'`));
  expect(pending.rows).toEqual([{ dedup_key: 'dunning:2026-05-11' }]);
});

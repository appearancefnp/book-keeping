import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker, workerPool } from '../../src/db/pool.js';
import { enqueue, claimDue, completeJob, failJob, backoffMs } from '../../src/jobs/queue.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const LEASE = 5 * 60 * 1000;

test('enqueue inserts; same dedup_key is a no-op', async () => {
  const c = ctx(await makeFirmAndClient());
  const first = await withTenant(c, (tx) => enqueue(tx, c, { type: 'test', runAt: new Date(), dedupKey: 'k1' }));
  const second = await withTenant(c, (tx) => enqueue(tx, c, { type: 'test', runAt: new Date(), dedupKey: 'k1' }));
  expect(first).toHaveProperty('jobId');
  expect(second).toEqual({ deduped: true });
  const count = await withWorker((tx) => tx.query(`SELECT count(*)::int AS n FROM jobs`));
  expect(count.rows[0].n).toBe(1);
});

test('claimDue returns only due pending jobs and marks them running', async () => {
  const c = ctx(await makeFirmAndClient());
  await withTenant(c, (tx) => enqueue(tx, c, { type: 'test', runAt: new Date(Date.now() - 1000) })); // due
  await withTenant(c, (tx) => enqueue(tx, c, { type: 'test', runAt: new Date(Date.now() + 60_000) })); // future
  const claimed = await withWorker((tx) => claimDue(tx, { now: new Date(), leaseTimeoutMs: LEASE, limit: 10 }));
  expect(claimed).toHaveLength(1);
  const row = await withWorker((tx) => tx.query(`SELECT status, attempts, claimed_at FROM jobs WHERE id = $1`, [claimed[0]!.id]));
  expect(row.rows[0].status).toBe('running');
  expect(row.rows[0].attempts).toBe(1);
  expect(row.rows[0].claimed_at).not.toBeNull();
});

test('SKIP LOCKED: two concurrent claimers never grab the same job', async () => {
  const c = ctx(await makeFirmAndClient());
  await withTenant(c, (tx) => enqueue(tx, c, { type: 'test', runAt: new Date(Date.now() - 1000) }));

  const c1 = await workerPool.connect();
  const c2 = await workerPool.connect();
  try {
    await c1.query('BEGIN'); await c2.query('BEGIN');
    const r1 = await claimDue(c1, { now: new Date(), leaseTimeoutMs: LEASE, limit: 10 });
    const r2 = await claimDue(c2, { now: new Date(), leaseTimeoutMs: LEASE, limit: 10 });
    await c1.query('COMMIT'); await c2.query('COMMIT');
    expect(r1.length + r2.length).toBe(1); // exactly one claimer wins
  } finally {
    c1.release(); c2.release();
  }
});

test('lease reclaim: a stale running job is re-claimable, a fresh one is not', async () => {
  const c = ctx(await makeFirmAndClient());
  const res = await withTenant(c, (tx) => enqueue(tx, c, { type: 'test', runAt: new Date(Date.now() - 1000) }));
  const jobId = (res as { jobId: string }).jobId;
  // Simulate a crashed worker: running with an old claimed_at.
  await withWorker((tx) => tx.query(
    `UPDATE jobs SET status='running', claimed_at = now() - interval '10 minutes' WHERE id = $1`, [jobId]));
  const reclaimed = await withWorker((tx) => claimDue(tx, { now: new Date(), leaseTimeoutMs: LEASE, limit: 10 }));
  expect(reclaimed.map((j) => j.id)).toContain(jobId);

  // A freshly-claimed job is NOT reclaimable.
  await withWorker((tx) => tx.query(`UPDATE jobs SET status='running', claimed_at = now() WHERE id = $1`, [jobId]));
  const none = await withWorker((tx) => claimDue(tx, { now: new Date(), leaseTimeoutMs: LEASE, limit: 10 }));
  expect(none).toHaveLength(0);
});

test('failJob under max_attempts re-queues with backoff; at max it dies', async () => {
  const c = ctx(await makeFirmAndClient());
  const res = await withTenant(c, (tx) => enqueue(tx, c, { type: 'test', runAt: new Date(Date.now() - 1000), maxAttempts: 2 }));
  const jobId = (res as { jobId: string }).jobId;

  await withWorker((tx) => claimDue(tx, { now: new Date(), leaseTimeoutMs: LEASE, limit: 10 })); // attempts=1
  await withWorker((tx) => failJob(tx, jobId, 'boom', { now: new Date() }));
  let row = await withWorker((tx) => tx.query(`SELECT status, run_at, last_error FROM jobs WHERE id=$1`, [jobId]));
  expect(row.rows[0].status).toBe('pending');
  expect(row.rows[0].last_error).toBe('boom');
  expect(new Date(row.rows[0].run_at).getTime()).toBeGreaterThan(Date.now());

  // Force run_at into the past, claim again (attempts=2 = max), fail again -> dead.
  await withWorker((tx) => tx.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE id=$1`, [jobId]));
  await withWorker((tx) => claimDue(tx, { now: new Date(), leaseTimeoutMs: LEASE, limit: 10 }));
  await withWorker((tx) => failJob(tx, jobId, 'boom2', { now: new Date() }));
  row = await withWorker((tx) => tx.query(`SELECT status FROM jobs WHERE id=$1`, [jobId]));
  expect(row.rows[0].status).toBe('failed');
});

test('backoffMs is exponential and capped at one hour', () => {
  expect(backoffMs(0)).toBe(1000);
  expect(backoffMs(1)).toBe(2000);
  expect(backoffMs(2)).toBe(4000);
  expect(backoffMs(100)).toBe(3_600_000); // capped
});

test('completeJob marks done', async () => {
  const c = ctx(await makeFirmAndClient());
  const res = await withTenant(c, (tx) => enqueue(tx, c, { type: 'test', runAt: new Date(Date.now() - 1000) }));
  const jobId = (res as { jobId: string }).jobId;
  await withWorker((tx) => claimDue(tx, { now: new Date(), leaseTimeoutMs: LEASE, limit: 10 }));
  await withWorker((tx) => completeJob(tx, jobId));
  const row = await withWorker((tx) => tx.query(`SELECT status FROM jobs WHERE id=$1`, [jobId]));
  expect(row.rows[0].status).toBe('done');
});

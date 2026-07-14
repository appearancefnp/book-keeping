import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant, withWorker } from '../../src/db/pool.js';
import { setup, issueOpenReceivable } from '../receivables/helpers.js';
import { drainOnce } from '../../src/jobs/worker.js';
import { enqueueDunningRun } from '../../src/dunning/schedule.js';
import { listTasks } from '../../src/collab/tasks.js';

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

test('at-least-once redelivery of the same date produces one task', async () => {
  const { cid, customerId } = await setup();
  await issueOpenReceivable(cid, customerId, { dueDate: '2026-03-10' });
  // First run.
  await withTenant(cid, (tx) => enqueueDunningRun(tx, cid, { asOf: '2026-03-30' }));
  await drainOnce({ now: new Date(), leaseTimeoutMs: LEASE, limit: 10 });
  // Simulate redelivery: enqueue the SAME asOf again by clearing dedup (new job row) and draining.
  await withTenant(cid, (tx) => tx.query(
    `INSERT INTO jobs(client_company_id, firm_id, type, run_at, payload)
     VALUES ($1,$2,'dunning_run', now() - interval '1 second', '{"asOf":"2026-03-30"}')`,
    [cid.clientCompanyId, cid.firmId]));
  await drainOnce({ now: new Date(), leaseTimeoutMs: LEASE, limit: 10 });

  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(1); // dunning idempotency (Task 5) prevents a duplicate
});

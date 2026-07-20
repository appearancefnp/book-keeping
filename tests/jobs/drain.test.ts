import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker } from '../../src/db/pool.js';
import { enqueue } from '../../src/jobs/queue.js';
import { registerHandler } from '../../src/jobs/handlers.js';
import { drainOnce } from '../../src/jobs/worker.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });
const LEASE = 5 * 60 * 1000;

test('drainOnce runs a handler under the job\'s tenant and marks it done', async () => {
  const c = ctx(await makeFirmAndClient());
  const seen: Array<{ role: string; client: string; note: unknown }> = [];
  registerHandler('unit_ok', async (_tx, hctx, payload) => {
    seen.push({ role: hctx.actorRole, client: hctx.clientCompanyId, note: payload.note });
  });
  await withTenant(c, (tx) => enqueue(tx, c, { type: 'unit_ok', runAt: new Date(Date.now() - 1000), payload: { note: 'hi' } }));

  const result = await drainOnce({ now: new Date(), leaseTimeoutMs: LEASE, limit: 10 });
  expect(result.ran).toBe(1);
  expect(seen).toEqual([{ role: 'system', client: c.clientCompanyId, note: 'hi' }]);

  const row = await withWorker((tx) => tx.query(`SELECT status FROM jobs`));
  expect(row.rows[0].status).toBe('done');
});

test('drainOnce marks a throwing handler failed (requeued with attempts bumped)', async () => {
  const c = ctx(await makeFirmAndClient());
  registerHandler('unit_boom', async () => { throw new Error('handler exploded'); });
  await withTenant(c, (tx) => enqueue(tx, c, { type: 'unit_boom', runAt: new Date(Date.now() - 1000), maxAttempts: 3 }));

  const result = await drainOnce({ now: new Date(), leaseTimeoutMs: LEASE, limit: 10 });
  expect(result.failed).toBe(1);
  const row = await withWorker((tx) => tx.query(`SELECT status, attempts, last_error FROM jobs`));
  expect(row.rows[0].status).toBe('pending'); // under max_attempts -> requeued
  expect(row.rows[0].attempts).toBe(1);
  expect(row.rows[0].last_error).toMatch(/handler exploded/);
});

test('drainOnce fails cleanly for an unknown job type', async () => {
  const c = ctx(await makeFirmAndClient());
  await withTenant(c, (tx) => enqueue(tx, c, { type: 'does_not_exist', runAt: new Date(Date.now() - 1000) }));
  const result = await drainOnce({ now: new Date(), leaseTimeoutMs: LEASE, limit: 10 });
  expect(result.failed).toBe(1);
  const row = await withWorker((tx) => tx.query(`SELECT last_error FROM jobs`));
  expect(row.rows[0].last_error).toMatch(/no handler/i);
});

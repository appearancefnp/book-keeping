import { fileURLToPath } from 'node:url';
import type { TenantContext } from '../tenancy/context.js';
import { appPool, workerPool, supervisorPool, withTenant, withWorker } from '../db/pool.js';
import { claimDue, completeJob, failJob, type Job } from './queue.js';
import { getHandler } from './handlers.js';
import { reapOnce } from './reapers.js';
import './register.js'; // side-effect: registers real handlers (dunning_run, later recurring_generate)

const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 15 * 1000;
const BATCH_LIMIT = 20;
const REAP_INTERVAL_MS = 60 * 1000;

/** Synthetic tenant context for worker-run handlers (no user session). */
export function workerCtx(job: Job): TenantContext {
  return { firmId: job.firmId, clientCompanyId: job.clientCompanyId, actorId: 'system', actorRole: 'system' };
}

/** One drain cycle: claim due jobs on the worker path, run each handler on the app path. */
export async function drainOnce(
  args: { now: Date; leaseTimeoutMs: number; limit: number },
): Promise<{ ran: number; failed: number }> {
  const jobs = await withWorker((tx) => claimDue(tx, args));
  let ran = 0, failed = 0;
  for (const job of jobs) {
    try {
      const handler = getHandler(job.type);
      if (!handler) throw new Error(`no handler registered for job type '${job.type}'`);
      const wctx = workerCtx(job);
      await withTenant(wctx, (tx) => handler(tx, wctx, job.payload));
      await withWorker((tx) => completeJob(tx, job.id));
      ran += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await withWorker((tx) => failJob(tx, job.id, msg, { now: args.now }));
      failed += 1;
    }
  }
  return { ran, failed };
}

async function main(): Promise<void> {
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  console.log('[worker] started');
  let lastReapAt = 0;
  while (!stopping) {
    try {
      const { ran, failed } = await drainOnce({ now: new Date(), leaseTimeoutMs: LEASE_TIMEOUT_MS, limit: BATCH_LIMIT });
      if (ran || failed) console.log(`[worker] ran=${ran} failed=${failed}`);
    } catch (err) {
      console.error('[worker] drain error', err);
    }
    const nowMs = Date.now();
    if (nowMs - lastReapAt >= REAP_INTERVAL_MS) {
      lastReapAt = nowMs;
      try {
        const { seeded } = await reapOnce({ now: new Date() });
        if (seeded) console.log(`[worker] reaped seeded=${seeded}`);
      } catch (err) {
        console.error('[worker] reap error', err);
      }
    }
    if (!stopping) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log('[worker] shutting down');
  await Promise.all([appPool.end(), workerPool.end(), supervisorPool.end()]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

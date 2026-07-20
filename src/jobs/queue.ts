import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface Job {
  id: string;
  clientCompanyId: string;
  firmId: string;
  type: string;
  status: string;
  runAt: Date;
  payload: Record<string, unknown>;
  dedupKey: string | null;
  attempts: number;
  maxAttempts: number;
}

export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 3_600_000);
}

/** Tenant path (bookkeeping_app, inside a withTenant tx). Idempotent on (client, type, dedup_key). */
export async function enqueue(
  tx: PoolClient, ctx: TenantContext,
  args: { type: string; runAt: Date; payload?: Record<string, unknown>; dedupKey?: string; maxAttempts?: number },
): Promise<{ jobId: string } | { deduped: true }> {
  const res = await tx.query(
    `INSERT INTO jobs(client_company_id, firm_id, type, run_at, payload, dedup_key, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (client_company_id, type, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      ctx.clientCompanyId, ctx.firmId, args.type, args.runAt.toISOString(),
      JSON.stringify(args.payload ?? {}), args.dedupKey ?? null, args.maxAttempts ?? 5,
    ],
  );
  if (!res.rowCount) return { deduped: true };
  return { jobId: res.rows[0].id as string };
}

function mapJob(r: Record<string, unknown>): Job {
  return {
    id: r.id as string,
    clientCompanyId: r.client_company_id as string,
    firmId: r.firm_id as string,
    type: r.type as string,
    status: r.status as string,
    runAt: new Date(r.run_at as string),
    payload: (r.payload ?? {}) as Record<string, unknown>,
    dedupKey: (r.dedup_key ?? null) as string | null,
    attempts: r.attempts as number,
    maxAttempts: r.max_attempts as number,
  };
}

/**
 * Worker path (bookkeeping_worker, inside a withWorker tx). Claims due pending jobs AND stale
 * running jobs (crashed workers) in one statement with FOR UPDATE SKIP LOCKED, transitions them
 * to 'running', bumps attempts, and stamps claimed_at.
 */
export async function claimDue(
  tx: PoolClient, args: { now: Date; leaseTimeoutMs: number; limit: number },
): Promise<Job[]> {
  const staleCutoff = new Date(args.now.getTime() - args.leaseTimeoutMs);
  const res = await tx.query(
    `UPDATE jobs SET status='running', claimed_at=$1, attempts=attempts+1, updated_at=now()
     WHERE id IN (
       SELECT id FROM jobs
       WHERE (status='pending' AND run_at <= $1)
          OR (status='running' AND claimed_at < $2)
       ORDER BY run_at
       FOR UPDATE SKIP LOCKED
       LIMIT $3
     )
     RETURNING *`,
    [args.now.toISOString(), staleCutoff.toISOString(), args.limit],
  );
  return res.rows.map(mapJob);
}

export async function completeJob(tx: PoolClient, jobId: string): Promise<void> {
  await tx.query(`UPDATE jobs SET status='done', updated_at=now() WHERE id=$1`, [jobId]);
}

/**
 * Worker path. Reads the (already-incremented) attempts: at/over max_attempts the job dies
 * ('failed'); otherwise it returns to 'pending' with run_at pushed out by exponential backoff.
 * Safe as read-then-write because claimDue's SKIP LOCKED + lease guarantees a single owner per running job.
 */
export async function failJob(
  tx: PoolClient, jobId: string, error: string, args: { now: Date },
): Promise<void> {
  const cur = await tx.query(`SELECT attempts, max_attempts FROM jobs WHERE id=$1`, [jobId]);
  if (!cur.rowCount) return;
  const { attempts, max_attempts } = cur.rows[0] as { attempts: number; max_attempts: number };
  if (attempts >= max_attempts) {
    await tx.query(
      `UPDATE jobs SET status='failed', last_error=$2, claimed_at=NULL, updated_at=now() WHERE id=$1`,
      [jobId, error]);
  } else {
    const nextRun = new Date(args.now.getTime() + backoffMs(attempts));
    await tx.query(
      `UPDATE jobs SET status='pending', run_at=$2, last_error=$3, claimed_at=NULL, updated_at=now() WHERE id=$1`,
      [jobId, nextRun.toISOString(), error]);
  }
}

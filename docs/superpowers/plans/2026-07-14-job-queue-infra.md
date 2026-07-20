# Job Queue Infrastructure (M4 slice C-infra) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable Postgres job queue drained by a standalone worker process, and migrate dunning onto it as the first consumer.

**Architecture:** A `jobs` table is control-plane infrastructure with an explicit dual-RLS-policy design: tenant code (`bookkeeping_app`) enqueues and reads its own jobs under the normal tenant-isolation policy, while a new least-privilege `bookkeeping_worker` role claims jobs across all tenants via a `USING(true)` policy. The worker uses two connection paths — the control path (`bookkeeping_worker`) claims/completes jobs; the execution path (`bookkeeping_app` via `withTenant`) runs each job's handler under normal RLS. Delivery is at-least-once; every handler is idempotent (dunning via `ON CONFLICT DO NOTHING`). Jobs self-perpetuate: a handler enqueues its next occurrence.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `pg`, Postgres 16, vitest against a real DB, Next.js (`web/`) for the one route change.

## Global Constraints

- Node 24+; TypeScript ESM — **all relative imports use the `.js` extension** (e.g. `import { withTenant } from '../db/pool.js'`).
- Tests run against a real Postgres via `npm test` (vitest, `singleFork`, `fileParallelism: false`). `tests/setup.ts` loads `.env` via `process.loadEnvFile('.env')`, so any new env var must be present in the local `.env`.
- RLS is enforced via `withTenant` and **never bypassed** — the `jobs` control-plane dual-policy design is the one documented, test-guarded exception. No `BYPASSRLS`.
- Integer cents everywhere; money as strings across boundaries.
- Migrations run as `admin`, one file per transaction, applied in filename order; `000_`-prefixed bootstrap runs first and is idempotent. Role creation uses the idempotent `DO $$ ... IF NOT EXISTS ... $$` pattern from `000_bootstrap.sql`.
- `bookkeeping_worker` is granted **only** `SELECT, UPDATE` on `jobs` and `USAGE` on schema `public` — no grants on any business table.
- New env var: `WORKER_DATABASE_URL=postgres://bookkeeping_worker:worker_pw@localhost:5433/bookkeeping`.
- Conventional-commit messages; commit after each task. No new user-facing UI strings in this slice (no i18n changes needed).
- **Branch:** off `m4b-dunning` (this migrates the dunning code, which lives there). Confirm the base is still current in case PRs #2/#4 have merged to `main`.

---

### Task 1: Migration `034_jobs.sql` — jobs table + worker role

**Files:**
- Create: `migrations/034_jobs.sql`
- Test: `tests/jobs/schema.test.ts`

**Interfaces:**
- Consumes: existing `client_companies(id)`, `firms(id)`, `bookkeeping_app` role, `pgcrypto` (`gen_random_uuid()`), `withTenant` from `src/db/pool.ts`.
- Produces: table `jobs` with columns `id, client_company_id, firm_id, type, status, run_at, payload, dedup_key, attempts, max_attempts, last_error, claimed_at, created_at, updated_at`; role `bookkeeping_worker`; policies `jobs_tenant_isolation` (bookkeeping_app) and `jobs_worker_all` (bookkeeping_worker).

- [ ] **Step 1: Write the failing test**

Create `tests/jobs/schema.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { adminPool, withTenant } from '../../src/db/pool.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('jobs table and worker role exist after migration', async () => {
  const cols = await adminPool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'jobs' ORDER BY column_name`,
  );
  const names = cols.rows.map((r) => r.column_name);
  expect(names).toEqual(expect.arrayContaining([
    'id', 'client_company_id', 'firm_id', 'type', 'status', 'run_at',
    'payload', 'dedup_key', 'attempts', 'max_attempts', 'last_error',
    'claimed_at', 'created_at', 'updated_at',
  ]));

  const role = await adminPool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'bookkeeping_worker'`);
  expect(role.rowCount).toBe(1);
});

test('bookkeeping_app tenant isolation: a client cannot see another client\'s jobs', async () => {
  const a = ctx(await makeFirmAndClient('SIA A'));
  const b = ctx(await makeFirmAndClient('SIA B'));

  await withTenant(a, (tx) => tx.query(
    `INSERT INTO jobs(client_company_id, firm_id, type, run_at) VALUES ($1,$2,'test',now())`,
    [a.clientCompanyId, a.firmId],
  ));

  const seenByB = await withTenant(b, (tx) => tx.query(`SELECT id FROM jobs`));
  expect(seenByB.rowCount).toBe(0);

  const seenByA = await withTenant(a, (tx) => tx.query(`SELECT id FROM jobs`));
  expect(seenByA.rowCount).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/jobs/schema.test.ts`
Expected: FAIL — relation "jobs" does not exist.

- [ ] **Step 3: Write the migration**

Create `migrations/034_jobs.sql`:

```sql
-- Durable job queue (M4 slice C-infra). Control-plane infra table, NOT ordinary tenant data:
-- tenant code enqueues/reads its own rows under the standard tenant-isolation policy, while a
-- dedicated least-privilege bookkeeping_worker role claims across all tenants via USING(true).
-- Runs as admin inside one transaction (CREATE ROLE is transactional in Postgres).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookkeeping_worker') THEN
    CREATE ROLE bookkeeping_worker LOGIN PASSWORD 'worker_pw';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO bookkeeping_worker;

CREATE TABLE jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  firm_id           uuid NOT NULL REFERENCES firms(id),
  type              text NOT NULL,
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','running','done','failed')),
  run_at            timestamptz NOT NULL,
  payload           jsonb NOT NULL DEFAULT '{}',
  dedup_key         text,
  attempts          int  NOT NULL DEFAULT 0,
  max_attempts      int  NOT NULL DEFAULT 5,
  last_error        text,
  claimed_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX jobs_dedup_idx
  ON jobs(client_company_id, type, dedup_key) WHERE dedup_key IS NOT NULL;

CREATE INDEX jobs_claim_idx ON jobs(status, run_at) WHERE status IN ('pending','running');

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY jobs_tenant_isolation ON jobs TO bookkeeping_app
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

CREATE POLICY jobs_worker_all ON jobs TO bookkeeping_worker
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON jobs TO bookkeeping_app;
GRANT SELECT, UPDATE ON jobs TO bookkeeping_worker;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/jobs/schema.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add migrations/034_jobs.sql tests/jobs/schema.test.ts
git commit -m "feat(jobs): jobs table + bookkeeping_worker role with dual RLS policies"
```

---

### Task 2: Worker connection path (`workerPool` + `withWorker`)

**Files:**
- Modify: `src/db/pool.ts` (add `workerPool` and `withWorker`)
- Modify: `tests/helpers/db.ts` (end `workerPool` in `closeDb`)
- Modify: `.env.example` (add `WORKER_DATABASE_URL`)
- Test: `tests/jobs/rls.test.ts`

**Interfaces:**
- Consumes: `pg.Pool`, `WORKER_DATABASE_URL`.
- Produces:
  - `export const workerPool: Pool` — connected as `bookkeeping_worker`.
  - `export async function withWorker<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T>` — runs `fn` in a transaction on `workerPool` (BEGIN/COMMIT, ROLLBACK on throw). **Does not** set `app.current_client_id` (the worker policy is cross-tenant).

- [ ] **Step 1: Add `WORKER_DATABASE_URL` to `.env.example` and your local `.env`**

Append to `.env.example`:

```
# Worker connection — least-privilege role, claims jobs across tenants (control plane only)
WORKER_DATABASE_URL=postgres://bookkeeping_worker:worker_pw@localhost:5433/bookkeeping
```

Also add the same line to your local `.env` (tests read it via `process.loadEnvFile('.env')`).

- [ ] **Step 2: Write the failing test**

Create `tests/jobs/rls.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker } from '../../src/db/pool.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('worker sees jobs across all tenants; app sees only its own', async () => {
  const a = ctx(await makeFirmAndClient('SIA A'));
  const b = ctx(await makeFirmAndClient('SIA B'));
  for (const t of [a, b]) {
    await withTenant(t, (tx) => tx.query(
      `INSERT INTO jobs(client_company_id, firm_id, type, run_at) VALUES ($1,$2,'test',now())`,
      [t.clientCompanyId, t.firmId],
    ));
  }
  const workerSees = await withWorker((tx) => tx.query(`SELECT id FROM jobs`));
  expect(workerSees.rowCount).toBe(2);
});

test('bookkeeping_worker has no privilege on business tables', async () => {
  await expect(
    withWorker((tx) => tx.query(`SELECT id FROM einvoices LIMIT 1`)),
  ).rejects.toThrow(/permission denied/i);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- tests/jobs/rls.test.ts`
Expected: FAIL — `withWorker` is not exported.

- [ ] **Step 4: Add `workerPool` + `withWorker` to `src/db/pool.ts`**

After the existing `appPool` declaration add:

```ts
export const workerPool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL });

/**
 * Runs `fn` in a transaction on the WORKER pool (bookkeeping_worker). Used only for the
 * control plane — claiming and completing jobs across all tenants. Does NOT set
 * app.current_client_id; business work runs separately via withTenant on the app pool.
 */
export async function withWorker<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await workerPool.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK');
    throw err;
  } finally {
    tx.release();
  }
}
```

- [ ] **Step 5: Update `closeDb` in `tests/helpers/db.ts`**

Change the import line and `closeDb`:

```ts
import { adminPool, appPool, workerPool } from '../../src/db/pool.js';
```

```ts
export async function closeDb(): Promise<void> {
  await Promise.all([adminPool.end(), appPool.end(), workerPool.end()]);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- tests/jobs/rls.test.ts`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add src/db/pool.ts tests/helpers/db.ts .env.example tests/jobs/rls.test.ts
git commit -m "feat(jobs): worker connection path (workerPool + withWorker) + RLS boundary tests"
```

---

### Task 3: Queue primitives (`src/jobs/queue.ts`)

**Files:**
- Create: `src/jobs/queue.ts`
- Test: `tests/jobs/queue.test.ts`

**Interfaces:**
- Consumes: `PoolClient`, `TenantContext`.
- Produces:
  - `interface Job { id: string; clientCompanyId: string; firmId: string; type: string; status: string; runAt: Date; payload: Record<string, unknown>; dedupKey: string | null; attempts: number; maxAttempts: number; }`
  - `enqueue(tx, ctx, args: { type: string; runAt: Date; payload?: Record<string, unknown>; dedupKey?: string; maxAttempts?: number }): Promise<{ jobId: string } | { deduped: true }>` — runs on the **tenant** path (inside a `withTenant` tx).
  - `claimDue(tx, args: { now: Date; leaseTimeoutMs: number; limit: number }): Promise<Job[]>` — runs on the **worker** path (inside a `withWorker` tx).
  - `completeJob(tx, jobId: string): Promise<void>` — worker path.
  - `failJob(tx, jobId: string, error: string, args: { now: Date }): Promise<void>` — worker path.
  - `backoffMs(attempts: number): number` — `min(2**attempts * 1000, 3_600_000)`.

- [ ] **Step 1: Write the failing test**

Create `tests/jobs/queue.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker, workerPool } from '../../src/db/pool.js';
import { enqueue, claimDue, completeJob, failJob } from '../../src/jobs/queue.js';

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

test('completeJob marks done', async () => {
  const c = ctx(await makeFirmAndClient());
  const res = await withTenant(c, (tx) => enqueue(tx, c, { type: 'test', runAt: new Date(Date.now() - 1000) }));
  const jobId = (res as { jobId: string }).jobId;
  await withWorker((tx) => claimDue(tx, { now: new Date(), leaseTimeoutMs: LEASE, limit: 10 }));
  await withWorker((tx) => completeJob(tx, jobId));
  const row = await withWorker((tx) => tx.query(`SELECT status FROM jobs WHERE id=$1`, [jobId]));
  expect(row.rows[0].status).toBe('done');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/jobs/queue.test.ts`
Expected: FAIL — cannot find module `src/jobs/queue.js`.

- [ ] **Step 3: Implement `src/jobs/queue.ts`**

```ts
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
     ON CONFLICT (client_company_id, type, dedup_key) DO NOTHING
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/jobs/queue.test.ts`
Expected: PASS (all six tests).

- [ ] **Step 5: Commit**

```bash
git add src/jobs/queue.ts tests/jobs/queue.test.ts
git commit -m "feat(jobs): queue primitives — enqueue, claimDue (SKIP LOCKED + lease), complete, fail+backoff"
```

---

### Task 4: Handler registry + drain cycle + worker process

**Files:**
- Create: `src/jobs/handlers.ts`
- Create: `src/jobs/worker.ts`
- Modify: `package.json` (add `worker` script)
- Test: `tests/jobs/drain.test.ts`

**Interfaces:**
- Consumes: `enqueue`/`claimDue`/`completeJob`/`failJob` (Task 3), `withTenant`/`withWorker` (Task 2), `Job`, `TenantContext`.
- Produces:
  - `type JobHandler = (tx: PoolClient, ctx: TenantContext, payload: Record<string, unknown>) => Promise<void>`
  - `const handlers: Map<string, JobHandler>` and `registerHandler(type, fn)` / `getHandler(type)` in `src/jobs/handlers.ts`.
  - `drainOnce(args: { now: Date; leaseTimeoutMs: number; limit: number }): Promise<{ ran: number; failed: number }>` in `src/jobs/worker.ts` — claims due jobs (worker path), runs each handler under `withTenant` with a system ctx, marks done/failed.
  - `workerCtx(job: Job): TenantContext` — `{ firmId, clientCompanyId, actorId: 'system', actorRole: 'system' }`.

- [ ] **Step 1: Write the failing test**

Create `tests/jobs/drain.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/jobs/drain.test.ts`
Expected: FAIL — cannot find `src/jobs/handlers.js` / `src/jobs/worker.js`.

- [ ] **Step 3: Implement `src/jobs/handlers.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export type JobHandler = (
  tx: PoolClient, ctx: TenantContext, payload: Record<string, unknown>,
) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerHandler(type: string, fn: JobHandler): void {
  handlers.set(type, fn);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}
```

- [ ] **Step 4: Implement `src/jobs/worker.ts`**

```ts
import { fileURLToPath } from 'node:url';
import type { TenantContext } from '../tenancy/context.js';
import { appPool, workerPool, withTenant, withWorker } from '../db/pool.js';
import { claimDue, completeJob, failJob, type Job } from './queue.js';
import { getHandler } from './handlers.js';
import './register.js'; // side-effect: registers real handlers (dunning_run, later recurring_generate)

const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 15 * 1000;
const BATCH_LIMIT = 20;

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
      await withTenant(workerCtx(job), (tx) => handler(tx, workerCtx(job), job.payload));
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
  while (!stopping) {
    try {
      const { ran, failed } = await drainOnce({ now: new Date(), leaseTimeoutMs: LEASE_TIMEOUT_MS, limit: BATCH_LIMIT });
      if (ran || failed) console.log(`[worker] ran=${ran} failed=${failed}`);
    } catch (err) {
      console.error('[worker] drain error', err);
    }
    if (!stopping) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.log('[worker] shutting down');
  await Promise.all([appPool.end(), workerPool.end()]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 5: Create an empty `src/jobs/register.ts` (real handlers land in Task 6)**

```ts
// Registers production job handlers as a side effect of import. Populated in Task 6.
export {};
```

- [ ] **Step 6: Add the `worker` script to root `package.json`**

In the `scripts` block, add:

```json
"worker": "node --env-file=.env --import tsx src/jobs/worker.ts"
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npm test -- tests/jobs/drain.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 8: Commit**

```bash
git add src/jobs/handlers.ts src/jobs/worker.ts src/jobs/register.ts package.json tests/jobs/drain.test.ts
git commit -m "feat(jobs): handler registry + drainOnce cycle + standalone worker (npm run worker)"
```

---

### Task 5: Make `runDunning` idempotent (event-first `ON CONFLICT`)

**Files:**
- Modify: `src/dunning/dunning.ts`
- Test: `tests/dunning/dunning.test.ts` (add one test; existing tests must still pass)

**Interfaces:**
- Consumes: existing `dunning_events` unique constraint `(client_company_id, einvoice_id, level)`.
- Produces: unchanged `runDunning` signature/return; internal insert becomes event-first `ON CONFLICT DO NOTHING RETURNING`, then `createTask`, then backfill `task_id`.

**Nature of this task — read before starting.** This is a **hardening refactor, not red-green TDD.** The current SELECT-then-INSERT already prevents duplicates for *sequential* runs, so the change's only behavioral difference surfaces under *concurrent/overlapping* runs (two workers running dunning for the same client at once): the old code's check-then-insert has a TOCTOU race that throws a unique-violation and aborts the whole `runDunning` transaction, whereas event-first `ON CONFLICT DO NOTHING` degrades gracefully. That race is timing-dependent and cannot be tested deterministically. So: add the regression test below as a **baseline pin** (it passes before *and* after — that is expected, not a mistake), make the refactor, and prove the change by keeping the entire dunning suite green.

- [ ] **Step 1: Add the regression test to `tests/dunning/dunning.test.ts`**

Append:

```ts
test('idempotent: a pre-existing event at that level creates no duplicate task and does not throw', async () => {
  const { cid, einvoiceId } = await overdueClient('2026-03-10');
  // Simulate a prior run that already recorded the level-2 event (no task attached yet).
  await withTenant(cid, (tx) => tx.query(
    `INSERT INTO dunning_events(client_company_id, einvoice_id, level, accrued_fee_cents)
     VALUES ($1,$2,2,0)`,
    [cid.clientCompanyId, einvoiceId],
  ));
  const summary = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' })); // 20d -> L2
  expect(summary.prompted).toBe(0); // level already claimed
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test to establish the baseline**

Run: `npm test -- tests/dunning/dunning.test.ts`
Expected: PASS (this pins current behavior; it must stay green after the refactor). Do not treat a pass here as "nothing to do" — proceed to Step 3.

- [ ] **Step 3: Rewrite the insert block in `runDunning`**

Replace this block:

```ts
    const dup = await tx.query(
      `SELECT 1 FROM dunning_events WHERE client_company_id = $1 AND einvoice_id = $2 AND level = $3`,
      [ctx.clientCompanyId, row.einvoiceId, reached.level],
    );
    if (dup.rowCount) continue;

    const fee = accruedLateFeeCents({
      outstandingCents: row.outstandingCents, daysOverdue,
      annualBps: policy.lateFeeAnnualBps, flatCents: policy.lateFeeFlatCents,
    });
    const title = `Chase invoice ${row.invoiceNumber} — ${daysOverdue} days overdue (level ${reached.level})`;
    const detail = `Outstanding ${centsToMajor(row.outstandingCents)}. Accrued late fee ${centsToMajor(fee)}.`;
    const { id: taskId } = await createTask(tx, ctx, { title, detail });
    await tx.query(
      `INSERT INTO dunning_events(client_company_id, einvoice_id, level, accrued_fee_cents, task_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [ctx.clientCompanyId, row.einvoiceId, reached.level, fee, taskId],
    );
    prompted += 1;
    byLevel[reached.level] = (byLevel[reached.level] ?? 0) + 1;
```

with:

```ts
    const fee = accruedLateFeeCents({
      outstandingCents: row.outstandingCents, daysOverdue,
      annualBps: policy.lateFeeAnnualBps, flatCents: policy.lateFeeFlatCents,
    });
    // Event-first: the unique (client, einvoice, level) constraint claims this level atomically,
    // so an overlapping/at-least-once redelivered run can't duplicate the task or abort mid-run.
    const claimed = await tx.query(
      `INSERT INTO dunning_events(client_company_id, einvoice_id, level, accrued_fee_cents)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (client_company_id, einvoice_id, level) DO NOTHING
       RETURNING id`,
      [ctx.clientCompanyId, row.einvoiceId, reached.level, fee],
    );
    if (!claimed.rowCount) continue; // already handled at this level
    const eventId = claimed.rows[0].id as string;

    const title = `Chase invoice ${row.invoiceNumber} — ${daysOverdue} days overdue (level ${reached.level})`;
    const detail = `Outstanding ${centsToMajor(row.outstandingCents)}. Accrued late fee ${centsToMajor(fee)}.`;
    const { id: taskId } = await createTask(tx, ctx, { title, detail });
    await tx.query(`UPDATE dunning_events SET task_id = $1 WHERE id = $2`, [taskId, eventId]);
    prompted += 1;
    byLevel[reached.level] = (byLevel[reached.level] ?? 0) + 1;
```

- [ ] **Step 4: Run the full dunning suite**

Run: `npm test -- tests/dunning/`
Expected: PASS (new test + all existing dunning tests).

- [ ] **Step 5: Commit**

```bash
git add src/dunning/dunning.ts tests/dunning/dunning.test.ts
git commit -m "fix(dunning): event-first ON CONFLICT idempotency for at-least-once execution"
```

---

### Task 6: Dunning as the first queue consumer

**Files:**
- Modify: `src/jobs/register.ts` (register `dunning_run`)
- Create: `src/dunning/schedule.ts` (`enqueueDunningRun` + date helpers)
- Modify: `web/app/api/receivables/dunning/policy/route.ts` (seed on enable)
- Create: `migrations/035_dunning_jobs_backfill.sql`
- Test: `tests/jobs/dunning-job.test.ts`

**Interfaces:**
- Consumes: `enqueue` (Task 3), `registerHandler` (Task 4), `runDunning` (Task 5), `withTenant`.
- Produces:
  - `enqueueDunningRun(tx, ctx, args: { asOf: string }): Promise<{ jobId: string } | { deduped: true }>` — enqueues a `dunning_run` for `asOf` at UTC-midnight, deduped on `dunning:<asOf>`.
  - `nextDay(isoDate: string): string` and `utcMidnight(isoDate: string): Date` in `src/dunning/schedule.ts`.
  - A registered `dunning_run` handler that calls `runDunning` then enqueues the next day's run.

- [ ] **Step 1: Write the failing test**

Create `tests/jobs/dunning-job.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/jobs/dunning-job.test.ts`
Expected: FAIL — cannot find `src/dunning/schedule.js`.

- [ ] **Step 3: Implement `src/dunning/schedule.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { enqueue } from '../jobs/queue.js';

/** UTC midnight of a YYYY-MM-DD date. */
export function utcMidnight(isoDate: string): Date {
  return new Date(isoDate + 'T00:00:00Z');
}

/** The next calendar day of a YYYY-MM-DD date, as YYYY-MM-DD (UTC). */
export function nextDay(isoDate: string): string {
  const d = utcMidnight(isoDate);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Enqueue a dunning_run for asOf at UTC midnight, deduped on the date. */
export async function enqueueDunningRun(
  tx: PoolClient, ctx: TenantContext, args: { asOf: string },
): Promise<{ jobId: string } | { deduped: true }> {
  return enqueue(tx, ctx, {
    type: 'dunning_run',
    runAt: utcMidnight(args.asOf),
    payload: { asOf: args.asOf },
    dedupKey: `dunning:${args.asOf}`,
  });
}
```

- [ ] **Step 4: Register the `dunning_run` handler in `src/jobs/register.ts`**

Replace the placeholder contents with:

```ts
// Registers production job handlers as a side effect of import.
import { registerHandler } from './handlers.js';
import { runDunning } from '../dunning/dunning.js';
import { enqueueDunningRun, nextDay } from '../dunning/schedule.js';

registerHandler('dunning_run', async (tx, ctx, payload) => {
  const asOf = (payload.asOf as string | undefined) ?? new Date().toISOString().slice(0, 10);
  await runDunning(tx, ctx, { asOf });
  // Self-perpetuate: enqueue tomorrow's run (deduped on the date).
  await enqueueDunningRun(tx, ctx, { asOf: nextDay(asOf) });
});
```

- [ ] **Step 5: Seed a dunning_run when a policy is enabled (web route)**

In `web/app/api/receivables/dunning/policy/route.ts`, add the import:

```ts
import { enqueueDunningRun } from '@domain/dunning/schedule.js';
```

and change the `withTenant` block in `PUT` to seed on enable:

```ts
    await withTenant(ctx, async (tx) => {
      await setDunningPolicy(tx, ctx, body.policy!);
      await setStages(tx, ctx, body.stages!);
      if (body.policy!.enabled) {
        const asOf = new Date().toISOString().slice(0, 10);
        await enqueueDunningRun(tx, ctx, { asOf });
      }
    });
```

(Confirm the `@domain/*` alias resolves to the repo-root `src/` in `web/` — it is already used for `@domain/dunning/policy.js` in this file.)

- [ ] **Step 6: Create the backfill migration `migrations/035_dunning_jobs_backfill.sql`**

```sql
-- Seed one dunning_run job for every client that already has dunning enabled, so existing
-- tenants start on the queue without manual action. Deduped on today's date; the handler
-- chains subsequent days. Runs as admin (RLS FORCE does not apply to a plain admin INSERT here
-- because admin is the table owner and this migration is trusted setup).
INSERT INTO jobs (client_company_id, firm_id, type, run_at, payload, dedup_key)
SELECT c.id, c.firm_id, 'dunning_run', now(),
       jsonb_build_object('asOf', now()::date::text),
       'dunning:' || now()::date::text
  FROM client_companies c
  JOIN dunning_policy p ON p.client_company_id = c.id
 WHERE p.enabled = true
ON CONFLICT (client_company_id, type, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING;
-- NOTE: the WHERE predicate is REQUIRED — jobs_dedup_idx is a partial unique index
-- (WHERE dedup_key IS NOT NULL), so ON CONFLICT inference must repeat that predicate.
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- tests/jobs/dunning-job.test.ts`
Expected: PASS (all three tests).

Then the full jobs + dunning suites:

Run: `npm test -- tests/jobs/ tests/dunning/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/jobs/register.ts src/dunning/schedule.ts web/app/api/receivables/dunning/policy/route.ts migrations/035_dunning_jobs_backfill.sql tests/jobs/dunning-job.test.ts
git commit -m "feat(jobs): dunning as first queue consumer — dunning_run handler, seed-on-enable, backfill"
```

---

### Task 7: Dunning route range validation

**Files:**
- Modify: `src/dunning/policy.ts` (`setDunningPolicy` + `setStages` guards)
- Test: `tests/dunning/routes.test.ts` (add cases)

**Interfaces:**
- Consumes: existing `setDunningPolicy` / `setStages`.
- Produces: both throw `Error` on out-of-range input; the dunning routes already map thrown errors to HTTP 400 via `errorToStatus` (default branch).

- [ ] **Step 1: Add failing tests to `tests/dunning/routes.test.ts`**

Append:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/dunning/routes.test.ts`
Expected: FAIL — no error thrown (negative values currently accepted).

- [ ] **Step 3: Add the guards**

In `src/dunning/policy.ts`, at the top of `setDunningPolicy` (before the `INSERT`):

```ts
  if (input.lateFeeAnnualBps < 0) throw new Error('lateFeeAnnualBps must be non-negative');
  if (BigInt(input.lateFeeFlatCents) < 0n) throw new Error('lateFeeFlatCents must be non-negative');
```

In `setStages`, inside the ascending-check loop area (after the distinct-levels check, before the DELETE), add:

```ts
  for (const s of stages) {
    if (s.daysOverdue < 0) throw new Error('Stage days_overdue must be non-negative');
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/dunning/routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dunning/policy.ts tests/dunning/routes.test.ts
git commit -m "fix(dunning): reject negative late-fee and stage-day inputs (clean 400s)"
```

---

### Final verification (after all tasks)

- [ ] **Full suite + typecheck**

Run: `npm test`
Expected: all tests pass (existing + new `tests/jobs/*`).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Manual worker smoke test (optional, documented in RUNNING.md follow-up)**

With `docker compose up -d db`, `npm run seed`, then in one terminal `npm run worker`; enqueue a due `dunning_run` for a seeded client and confirm the worker logs `ran=1` and a chase task appears. (This exercises the real loop end-to-end; not part of the automated suite by the deliberate coverage boundary in the spec.)

---

## Self-Review

**Spec coverage:**
- Role model / dual RLS policy → Task 1 (+ RLS boundary tests in Task 2). ✓
- Worker two-path connections → Task 2. ✓
- Schema (all columns, dedup index, claim index, retained terminal jobs) → Task 1. ✓
- Queue primitives (enqueue/claimDue/complete/fail + backoff + SKIP LOCKED + lease) → Task 3. ✓
- Handler registry + worker loop + `npm run worker` + system `TenantContext` → Task 4. ✓
- Dunning ON CONFLICT idempotency (follow-up #1) → Task 5. ✓
- Dunning-as-consumer, self-perpetuation, seed-on-enable, migration backfill → Task 6. ✓
- Dunning route range validation (follow-up #2) → Task 7. ✓
- Testing plan (queue primitives, RLS boundary, concurrency, lease, dunning-job idempotency + self-perpetuation, route validation) → Tasks 1–7. ✓
- Deferred: job retention/prune and C-recurring — correctly out of scope. ✓

**Type consistency:** `enqueue`/`claimDue`/`completeJob`/`failJob`/`backoffMs` signatures used identically in Tasks 3, 4, 6. `Job` shape defined once (Task 3) and consumed in Task 4. `workerCtx`/`drainOnce` defined in Task 4, consumed in Task 6. `enqueueDunningRun`/`nextDay`/`utcMidnight` defined in Task 6, `dunning_run` handler consumes them.

**Placeholder scan:** none — every code step shows full content. The one intentional two-step in Task 3 (the rewritten `failJob`) explicitly instructs deleting the first version; `src/jobs/register.ts` is deliberately an empty stub in Task 4 and filled in Task 6.

**Known confirmations left to the implementer (not placeholders — verifications):** migration number `034`/`035` still free on the base branch; `@domain/*` alias resolution in `web/` (already in use in the target file); `audit_log.actor_role` accepts `'system'` (verified: `text NOT NULL`, no CHECK).

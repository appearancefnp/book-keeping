# Chain Reaper / Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee every active dunning chain has a live job — recover terminal-`failed`, never-seeded, and re-enabled chains via a periodic supervisor sweep — and stop perpetuating disabled chains so `jobs` growth is capped.

**Architecture:** A new least-privilege `bookkeeping_supervisor` Postgres role runs a cross-tenant reap sweep (read active drivers + seed recovery jobs), kept separate from the job-transition `bookkeeping_worker` role. The sweep runs inside the existing worker loop, throttled, via a reaper registry parallel to the handler registry. Each feature registers its own reaper; this plan ships the dunning reaper.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), node-postgres (`pg`), Vitest, raw SQL migrations run as admin.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-14-chain-reaper-design.md`.
- Branch: `m4b-dunning` (do NOT branch; commit directly here).
- Migrations run as admin, one file per transaction; role creation must be idempotent (roles survive `resetDb`, which does `DROP SCHEMA public CASCADE`). Next free migration number is **036**.
- RLS via role policies, never bypassed; the supervisor `USING(true)` policies are documented control-plane carve-outs (like the worker's `jobs_worker_all`).
- At-least-once queue → handlers and reapers must be idempotent.
- Integer cents; import specifiers end in `.js`; tests are Vitest and run serially (`singleFork`).
- Verify each task with `npm run typecheck` and the task's tests; the full suite (`npm test`) must stay green (currently 386 passing).
- Local `.env` must gain `SUPERVISOR_DATABASE_URL` for tests to connect (see Task 1); `.env.example` documents it.

---

### Task 1: Supervisor role, pool, and RLS proof

**Files:**
- Create: `migrations/036_supervisor_role.sql`
- Modify: `src/db/pool.ts` (add `supervisorPool` + `withSupervisor`)
- Modify: `tests/helpers/db.ts` (end `supervisorPool` in `closeDb`)
- Modify: `.env.example` (document `SUPERVISOR_DATABASE_URL`)
- Modify local `.env` (add `SUPERVISOR_DATABASE_URL` — not committed)
- Test: `tests/jobs/supervisor-rls.test.ts`

**Interfaces:**
- Produces: `supervisorPool: Pool`; `withSupervisor<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T>` — a transaction on the supervisor pool that sets **no** tenant session var (like `withWorker`).
- Consumes: existing `makeFirmAndClient`, `ctx`, `resetDb`, `closeDb` from `tests/helpers/db.js`; `withTenant`, `withWorker` from `src/db/pool.js`.

- [ ] **Step 1: Write the migration**

Create `migrations/036_supervisor_role.sql`:

```sql
-- Chain reaper supervisor role (M4 C-infra follow-up). Trusted control-plane role that runs the
-- periodic reap sweep: reads which drivers are active (dunning_policy), resolves firm_id
-- (client_companies), reads jobs to detect dead/missing chains, and seeds recovery jobs. Kept
-- separate from bookkeeping_worker (which only transitions job state) to preserve least privilege.
-- Runs as admin in one transaction (CREATE ROLE is transactional in Postgres).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bookkeeping_supervisor') THEN
    CREATE ROLE bookkeeping_supervisor LOGIN PASSWORD 'supervisor_pw';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO bookkeeping_supervisor;

-- Read active drivers + resolve firm_id; read + seed jobs. No other business-table access.
GRANT SELECT ON dunning_policy TO bookkeeping_supervisor;
GRANT SELECT ON client_companies TO bookkeeping_supervisor;   -- no RLS on this table; GRANT suffices
GRANT SELECT, INSERT ON jobs TO bookkeeping_supervisor;

-- jobs has FORCE RLS with role-scoped policies (app/worker); add a control-plane policy for the
-- supervisor so it can read + seed across tenants.
CREATE POLICY jobs_supervisor_all ON jobs TO bookkeeping_supervisor
  USING (true) WITH CHECK (true);

-- dunning_policy has FORCE RLS. Its tenant-isolation policy has no TO clause (applies to all roles)
-- and evaluates to no rows when app.current_client_id is unset. Permissive policies are OR-combined,
-- so this supervisor policy re-opens cross-tenant read for the supervisor role only.
CREATE POLICY dunning_policy_supervisor_read ON dunning_policy TO bookkeeping_supervisor
  USING (true);
```

- [ ] **Step 2: Add `SUPERVISOR_DATABASE_URL` to `.env.example` and local `.env`**

Append to `.env.example`:

```
# Supervisor connection — least-privilege role that runs the chain reaper sweep (control plane only)
SUPERVISOR_DATABASE_URL=postgres://bookkeeping_supervisor:supervisor_pw@localhost:5433/bookkeeping
```

Add the same line to the local `.env` file (create it from `.env.example` if missing) so the test suite can connect.

- [ ] **Step 3: Add `supervisorPool` + `withSupervisor` to `src/db/pool.ts`**

Add after the `workerPool` declaration:

```typescript
export const supervisorPool = new Pool({ connectionString: process.env.SUPERVISOR_DATABASE_URL });
```

Add after `withWorker`:

```typescript
/**
 * Runs `fn` in a transaction on the SUPERVISOR pool (bookkeeping_supervisor). Used only by the
 * chain reaper: reads active drivers cross-tenant and seeds recovery jobs. Does NOT set
 * app.current_client_id.
 */
export async function withSupervisor<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await supervisorPool.connect();
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

- [ ] **Step 4: End `supervisorPool` in `tests/helpers/db.ts`**

Change the import and `closeDb`:

```typescript
import { adminPool, appPool, workerPool, supervisorPool } from '../../src/db/pool.js';
```

```typescript
export async function closeDb(): Promise<void> {
  await Promise.all([adminPool.end(), appPool.end(), workerPool.end(), supervisorPool.end()]);
}
```

- [ ] **Step 5: Write the failing RLS test**

Create `tests/jobs/supervisor-rls.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withSupervisor } from '../../src/db/pool.js';
import { setDunningPolicy } from '../../src/dunning/policy.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('supervisor reads dunning_policy + client_companies across tenants', async () => {
  const a = ctx(await makeFirmAndClient('SIA A'));
  const b = ctx(await makeFirmAndClient('SIA B'));
  for (const t of [a, b]) {
    await withTenant(t, (tx) => setDunningPolicy(tx, t, { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' }));
  }
  const policies = await withSupervisor((tx) => tx.query(`SELECT client_company_id FROM dunning_policy`));
  expect(policies.rowCount).toBe(2);
  const companies = await withSupervisor((tx) => tx.query(`SELECT id, firm_id FROM client_companies`));
  expect(companies.rowCount).toBe(2);
});

test('supervisor can insert a job across tenants', async () => {
  const a = ctx(await makeFirmAndClient('SIA A'));
  await withSupervisor((tx) => tx.query(
    `INSERT INTO jobs(client_company_id, firm_id, type, run_at) VALUES ($1,$2,'test',now())`,
    [a.clientCompanyId, a.firmId],
  ));
  const jobs = await withSupervisor((tx) => tx.query(`SELECT id FROM jobs`));
  expect(jobs.rowCount).toBe(1);
});

test('supervisor has no privilege on other business tables', async () => {
  await expect(
    withSupervisor((tx) => tx.query(`SELECT id FROM einvoices LIMIT 1`)),
  ).rejects.toThrow(/permission denied/i);
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npm test -- tests/jobs/supervisor-rls.test.ts`
Expected: FAIL — `withSupervisor` not exported / role connection error before the migration + pool exist.

- [ ] **Step 7: Run the test to verify it passes**

After Steps 1–4 are in place, run: `npm test -- tests/jobs/supervisor-rls.test.ts`
Expected: PASS (3 tests). Then `npm run typecheck` → clean.

- [ ] **Step 8: Commit**

```bash
git add migrations/036_supervisor_role.sql src/db/pool.ts tests/helpers/db.ts .env.example tests/jobs/supervisor-rls.test.ts
git commit -m "feat(jobs): add bookkeeping_supervisor role + withSupervisor for the chain reaper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `reapDunning` domain function

**Files:**
- Create: `src/dunning/reap.ts`
- Test: `tests/dunning/reap.test.ts`

**Interfaces:**
- Produces: `reapDunning(tx: PoolClient, args: { now: Date }): Promise<{ seeded: number }>` — runs on a supervisor tx; seeds one `dunning_run` per enabled policy client that has no live (`pending`/`running`) `dunning_run` job. Idempotent (dedup key `dunning:<today>`).
- Consumes: `withSupervisor`, `withTenant`, `withWorker` from `src/db/pool.js`; `setDunningPolicy` from `src/dunning/policy.js`; `enqueue` from `src/jobs/queue.js`; test helpers.

- [ ] **Step 1: Write the failing test**

Create `tests/dunning/reap.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/dunning/reap.test.ts`
Expected: FAIL — cannot import `reapDunning` from `../../src/dunning/reap.js`.

- [ ] **Step 3: Implement `src/dunning/reap.ts`**

```typescript
import type { PoolClient } from 'pg';

/**
 * Chain reaper for dunning (runs on a withSupervisor tx). Seeds today's dunning_run for every
 * enabled policy client that has no live (pending/running) dunning_run job — recovering
 * never-seeded and terminal-failed chains. Idempotent: the dunning:<today> dedup key makes a
 * re-run a no-op, and if today's job already exists (even failed) the insert is skipped, so the
 * chain self-heals on the next date rollover (<=1-day window, acceptable for informational dunning).
 */
export async function reapDunning(tx: PoolClient, args: { now: Date }): Promise<{ seeded: number }> {
  const today = args.now.toISOString().slice(0, 10);
  const res = await tx.query(
    `INSERT INTO jobs (client_company_id, firm_id, type, run_at, payload, dedup_key)
     SELECT c.id, c.firm_id, 'dunning_run', $1::timestamptz,
            jsonb_build_object('asOf', $2::text), 'dunning:' || $2::text
       FROM client_companies c
       JOIN dunning_policy p ON p.client_company_id = c.id
      WHERE p.enabled = true
        AND NOT EXISTS (
          SELECT 1 FROM jobs j
           WHERE j.client_company_id = c.id AND j.type = 'dunning_run'
             AND j.status IN ('pending','running'))
     ON CONFLICT (client_company_id, type, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [args.now.toISOString(), today],
  );
  return { seeded: res.rowCount ?? 0 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/dunning/reap.test.ts`
Expected: PASS (5 tests). Then `npm run typecheck` → clean.

- [ ] **Step 5: Commit**

```bash
git add src/dunning/reap.ts tests/dunning/reap.test.ts
git commit -m "feat(dunning): reapDunning seeds recovery jobs for enabled chains with no live job

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Reaper registry + `reapOnce`, register `reapDunning`

**Files:**
- Create: `src/jobs/reapers.ts`
- Modify: `src/jobs/register.ts` (register `reapDunning`)
- Test: `tests/jobs/reaper.test.ts`

**Interfaces:**
- Produces: `type Reaper = (tx: PoolClient, args: { now: Date }) => Promise<{ seeded: number }>`; `registerReaper(fn: Reaper): void`; `getReapers(): Reaper[]`; `reapOnce(args: { now: Date }): Promise<{ seeded: number }>` — opens one `withSupervisor` tx, runs every registered reaper, returns the summed `seeded`.
- Consumes: `withSupervisor` from `src/db/pool.js`; `reapDunning` from `src/dunning/reap.js`; existing `registerHandler` import side-effect pattern in `src/jobs/register.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/jobs/reaper.test.ts`:

```typescript
import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker } from '../../src/db/pool.js';
import { setDunningPolicy } from '../../src/dunning/policy.js';
import { reapOnce } from '../../src/jobs/reapers.js';
import '../../src/jobs/register.js'; // registers reapDunning

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('reapOnce runs registered reapers and seeds for an enabled dead chain', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => setDunningPolicy(tx, t, { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' }));
  const { seeded } = await reapOnce({ now: new Date('2026-05-10T09:00:00Z') });
  expect(seeded).toBe(1);
  const jobs = await withWorker((tx) => tx.query(`SELECT type, status FROM jobs`));
  expect(jobs.rows).toEqual([{ type: 'dunning_run', status: 'pending' }]);
});

test('reapOnce is idempotent across repeated sweeps', async () => {
  const t = ctx(await makeFirmAndClient());
  await withTenant(t, (tx) => setDunningPolicy(tx, t, { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' }));
  const now = new Date('2026-05-10T09:00:00Z');
  await reapOnce({ now });
  const second = await reapOnce({ now });
  expect(second.seeded).toBe(0);
  const n = await withWorker((tx) => tx.query(`SELECT count(*)::int AS n FROM jobs`));
  expect(n.rows[0].n).toBe(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/jobs/reaper.test.ts`
Expected: FAIL — cannot import `reapOnce` from `../../src/jobs/reapers.js`.

- [ ] **Step 3: Implement `src/jobs/reapers.ts`**

```typescript
import type { PoolClient } from 'pg';
import { withSupervisor } from '../db/pool.js';

export type Reaper = (tx: PoolClient, args: { now: Date }) => Promise<{ seeded: number }>;

const reapers: Reaper[] = [];

export function registerReaper(fn: Reaper): void {
  reapers.push(fn);
}

export function getReapers(): Reaper[] {
  return reapers;
}

/**
 * One reap sweep: run every registered reaper inside a single supervisor transaction and return
 * the total number of recovery jobs seeded. Reapers must be idempotent (at-least-once queue).
 */
export async function reapOnce(args: { now: Date }): Promise<{ seeded: number }> {
  return withSupervisor(async (tx) => {
    let seeded = 0;
    for (const reap of reapers) {
      const r = await reap(tx, args);
      seeded += r.seeded;
    }
    return { seeded };
  });
}
```

- [ ] **Step 4: Register `reapDunning` in `src/jobs/register.ts`**

Add the imports and registration (keep the existing `registerHandler('dunning_run', ...)` block):

```typescript
import { registerReaper } from './reapers.js';
import { reapDunning } from '../dunning/reap.js';

registerReaper(reapDunning);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -- tests/jobs/reaper.test.ts`
Expected: PASS (2 tests). Then `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/reapers.ts src/jobs/register.ts tests/jobs/reaper.test.ts
git commit -m "feat(jobs): reaper registry + reapOnce; register dunning reaper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Growth-cap — stop perpetuating a disabled chain

**Files:**
- Modify: `src/dunning/dunning.ts:27-31` (`runDunning` result gains `enabled`)
- Modify: `src/jobs/register.ts` (perpetuate only when enabled)
- Test: `tests/jobs/dunning-job.test.ts` (add two cases)

**Interfaces:**
- Produces: `runDunning(...)` now returns `{ enabled: boolean; prompted: number; byLevel: Record<number, number> }`. The `dunning_run` handler calls `enqueueDunningRun` for the next day **only when `enabled` is true**.
- Consumes: `drainOnce` from `src/jobs/worker.js`; `enqueue`, `withTenant`, `withWorker` from queue/pool; `setDunningPolicy` from `src/dunning/policy.js`.

- [ ] **Step 1: Write the failing test**

Append to `tests/jobs/dunning-job.test.ts` (reuse the file's existing imports; add any missing ones — `setDunningPolicy` from `../../src/dunning/policy.js`, `enqueue` from `../../src/jobs/queue.js`, `drainOnce` from `../../src/jobs/worker.js`, `withTenant`/`withWorker` from `../../src/db/pool.js`):

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/jobs/dunning-job.test.ts`
Expected: FAIL — the disabled case still enqueues a successor (perpetuation is currently unconditional), so `pending.n` is 1, not 0.

- [ ] **Step 3: Make `runDunning` return `enabled`**

In `src/dunning/dunning.ts`, update the signature return type and both return sites:

```typescript
export async function runDunning(
  tx: PoolClient, ctx: TenantContext, opts: { asOf: string },
): Promise<{ enabled: boolean; prompted: number; byLevel: Record<number, number> }> {
  const byLevel: Record<number, number> = {};
  const policy = await getDunningPolicy(tx, ctx);
  if (!policy.enabled) return { enabled: false, prompted: 0, byLevel };
```

Update the final `return` of the function (currently `return { prompted, byLevel };`) to:

```typescript
  return { enabled: true, prompted, byLevel };
```

- [ ] **Step 4: Gate perpetuation in `src/jobs/register.ts`**

Change the `dunning_run` handler body so it perpetuates only when enabled:

```typescript
registerHandler('dunning_run', async (tx, ctx, payload) => {
  const asOf = (payload.asOf as string | undefined) ?? new Date().toISOString().slice(0, 10);
  const { enabled } = await runDunning(tx, ctx, { asOf });
  // Self-perpetuate only while the policy is enabled (else jobs would grow one row/client/day).
  if (enabled) await enqueueDunningRun(tx, ctx, { asOf: nextDay(asOf) });
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -- tests/jobs/dunning-job.test.ts`
Expected: PASS (existing cases + the two new ones). Then `npm run typecheck` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/dunning/dunning.ts src/jobs/register.ts tests/jobs/dunning-job.test.ts
git commit -m "fix(dunning): stop perpetuating the chain when the policy is disabled

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire the reaper into the worker loop + full verification

**Files:**
- Modify: `src/jobs/worker.ts` (call `reapOnce` on an interval inside `main()`; end `supervisorPool` on shutdown)

**Interfaces:**
- Consumes: `reapOnce` from `src/jobs/reapers.js`; `supervisorPool` from `src/db/pool.js`.
- Produces: no new exported API; `main()` runs a throttled reap sweep every `REAP_INTERVAL_MS`.

- [ ] **Step 1: Add the reap interval constant and pool import**

In `src/jobs/worker.ts`, extend the pool import and add the constant near the existing ones:

```typescript
import { appPool, workerPool, supervisorPool, withTenant, withWorker } from '../db/pool.js';
import { reapOnce } from './reapers.js';
```

```typescript
const REAP_INTERVAL_MS = 60 * 1000;
```

- [ ] **Step 2: Call `reapOnce` on an interval inside `main()`**

In `main()`, before the `while` loop add a tracker, and inside the loop (after the `drainOnce` block, before the poll sleep) run a throttled reap. Wrap it so a reap error never kills the worker:

```typescript
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
```

- [ ] **Step 3: End `supervisorPool` on shutdown**

Change the shutdown line from `await Promise.all([appPool.end(), workerPool.end()]);` to:

```typescript
  await Promise.all([appPool.end(), workerPool.end(), supervisorPool.end()]);
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: clean (no errors).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green — previous 386 plus the new reaper/supervisor/growth-cap tests.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/worker.ts
git commit -m "feat(jobs): run the chain reaper on an interval inside the worker loop

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Supervisor role + grants + RLS policies → Task 1. ✓
- `withSupervisor` connection → Task 1. ✓
- Worker-driven throttled sweep + `reapOnce` → Tasks 3 & 5. ✓
- Reaper registry parallel to handler registry → Task 3. ✓
- `reapDunning` SQL sweep with `NOT EXISTS(live job)` + `≤1-day` failed-today window → Task 2. ✓
- Growth-cap: `runDunning` returns `enabled`, conditional perpetuation → Task 4. ✓
- Migration 036, `.env.example`, files list → Tasks 1–5. ✓
- Tests: reaper cases, supervisor RLS (incl. negative), growth-cap → Tasks 1–4. ✓
- Scope boundary (no recurring reaper / no `UPDATE` grant / no prune) → respected; none added. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `reapDunning(tx, {now})` and `Reaper` signatures match across Tasks 2/3/5; `reapOnce({now})` consistent; `runDunning` return `{ enabled, prompted, byLevel }` used in Task 4 handler; `withSupervisor` signature consistent Tasks 1/2/3. ✓

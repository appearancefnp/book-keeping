# Design — M4 slice C-infra: durable job queue + worker

Date: 2026-07-14. Status: **designed, ready for implementation plan.**
Supersedes the scheduler section of `docs/superpowers/handoffs/2026-07-14-slice-c-recurring-invoices.md`.

## Context and decision

M4 slice C (recurring invoices) needs something to fire on a schedule. The codebase has **no
scheduler, cron, or job queue today** — the same gap that keeps slice B's dunning manual-trigger.
Resolving it unblocks both recurring generation *and* scheduled dunning.

The handoff recommended the smallest option (external cron → one authenticated tick route). We
deliberately chose the more robust path instead: a **durable Postgres job queue drained by a
standalone worker process**, with per-job retries, backoff, and idempotency. Rationale: recurring
invoicing and dunning are money-affecting, recurring-forever operations where a missed or
double-fired run has real consequences; a durable queue with idempotent handlers is worth the
extra infra.

Because the queue + worker is shared infrastructure that both dunning and recurring ride on, it is
split from the recurring feature into its own spec/PR:

- **C-infra (THIS spec):** `jobs` table, `src/jobs/` primitives, standalone worker, the
  `bookkeeping_worker` role, and **dunning migrated onto the queue as the first consumer** (which
  also folds in slice B's two deferred follow-ups).
- **C-recurring (separate, later spec):** `recurring_invoice_templates`, the generator registered
  as a `'recurring_generate'` job type, template CRUD + UI. Its open feature questions (approval
  posture, Peppol-send-on-generation, cadence model, end conditions, mid-stream edits, catch-up
  semantics) are deferred to that spec — they do not affect C-infra.

**Branching:** C-infra branches off `m4b-dunning` — it migrates the dunning code onto the queue,
so that code must be present (and `m4b-dunning` is itself stacked on slice A). C-recurring stacks
on C-infra. Confirm the base is still current at plan time in case PRs #2/#4 have merged to `main`.

## Architecture and role model (the crux)

A standalone worker must (a) find due jobs across **all** tenants, but (b) every business write it
triggers must stay RLS-bound to a single tenant. The two existing roles can't do both: `admin`
owns tables / runs migrations (not used at runtime); `bookkeeping_app` is RLS-bound to one tenant
per transaction via `withTenant` (`src/db/pool.ts`).

**Resolution — a third role + two connection paths:**

- Add a `bookkeeping_worker` login role (new migration, idempotent guard like `000_bootstrap.sql`;
  new `WORKER_DATABASE_URL`, added to `.env.example` and `docker-compose.yml`).
- `bookkeeping_worker` is granted **only** `SELECT, UPDATE` on `jobs` — no grants on any business
  table, so it *cannot* perform business writes even by accident.
- The `jobs` table has FORCE RLS with **two** policies: the standard tenant-isolation policy
  `TO bookkeeping_app` (tenant code enqueues and reads its own jobs, exactly like every other
  table), and a `TO bookkeeping_worker USING (true)` policy (the worker sees every tenant's jobs to
  claim them). No `BYPASSRLS`, no session-flag hack — the cross-tenant boundary is an explicit,
  role-scoped policy.

**The worker's two paths:**

1. **Control path** (`workerPool`, `bookkeeping_worker`): claim a due job with
   `SELECT … FOR UPDATE SKIP LOCKED`, mark it `running`, later mark `done`/`failed`. Touches only
   `jobs`.
2. **Execution path** (existing `appPool`, `bookkeeping_app`): run the job's handler inside
   `withTenant(ctxForThatClient, …)` — identical RLS enforcement to a normal web request. Same
   role, same audit story, no privilege divergence.

**At-least-once, not exactly-once.** Claim and handler run on separate connections, so a crash
between "handler committed" and "marked done" re-runs the job. This is acceptable **because every
handler is idempotent by design** — recurring generation dedupes on `(template_id, period)`,
dunning on `ON CONFLICT DO NOTHING`. A job stuck in `running` past a lease timeout (crashed worker)
is reclaimed. This is the honest, standard durable-queue posture, not a false exactly-once claim.

**Documented carve-out:** the queue is control-plane. Tenant isolation on it is enforced by an
explicit worker policy + execution-time `withTenant`, not by the usual single tenant-isolation
policy. This is the one intentional deviation from "RLS everywhere," and it is guarded by an
explicit RLS test (below).

## Schema — `migrations/034_jobs.sql`

(033_dunning.sql is the highest existing migration; confirm 034 is free at plan time.)

```sql
CREATE TABLE jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  firm_id           uuid NOT NULL REFERENCES firms(id),   -- captured at enqueue; worker builds ctx w/o extra read
  type              text NOT NULL,                         -- 'dunning_run'; later 'recurring_generate'
  status            text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','running','done','failed')),
  run_at            timestamptz NOT NULL,                  -- earliest time eligible to run
  payload           jsonb NOT NULL DEFAULT '{}',           -- handler args (e.g. {asOf} or {templateId,period})
  dedup_key         text,                                  -- caller-supplied idempotency key
  attempts          int  NOT NULL DEFAULT 0,
  max_attempts      int  NOT NULL DEFAULT 5,
  last_error        text,
  claimed_at        timestamptz,                           -- lease start; NULL unless running
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

GRANT SELECT, INSERT ON jobs TO bookkeeping_app;     -- enqueue + read own
GRANT SELECT, UPDATE ON jobs TO bookkeeping_worker;  -- claim + status transitions
```

Notes:
- **`dedup_key`** is the double-enqueue guard (mirrors slice B's `dunning_events` unique key). For
  self-perpetuating jobs it encodes the period — dunning uses `dunning:<YYYY-MM-DD>`; recurring
  later uses `<templateId>:<period>`. A retry re-enqueue with the same key is `ON CONFLICT DO
  NOTHING`.
- **`claimed_at`** implements the lease: a `running` job whose `claimed_at` is older than the lease
  timeout is reclaimable, so a crashed worker's jobs don't stick forever.
- **`run_at`** drives self-perpetuating scheduling — the handler enqueues the next occurrence with
  a future `run_at`. The queue *is* the schedule; the worker never scans business tables
  cross-tenant.
- **`firm_id`** captured at enqueue (the enqueuer's `ctx` has it) so the worker builds a
  `TenantContext` without needing read access to `client_companies`.
- **No `DELETE` grant** — done/failed jobs are retained as an audit trail, consistent with the
  append-only ethos. Retention/prune is a noted follow-up, not built here.

## Domain — `src/jobs/`

Pure-function domain over the real DB, per house convention.

**`src/jobs/queue.ts`** — primitives. `enqueue` runs on the tenant path (`bookkeeping_app`, inside
a caller's `withTenant` tx); `claimDue`/`completeJob`/`failJob` run on the control path
(`bookkeeping_worker`).

```
// Tenant path (bookkeeping_app, within caller's withTenant tx):
enqueue(tx, ctx, { type, runAt, payload?, dedupKey?, maxAttempts? }) -> { jobId } | { deduped: true }
  // INSERT ... (firm_id from ctx.firmId) ON CONFLICT (client_company_id, type, dedup_key) DO NOTHING RETURNING id

// Control path (bookkeeping_worker, workerPool):
claimDue(workerTx, { now, leaseTimeout, limit }) -> Job[]
  // SELECT ... WHERE (status='pending' AND run_at <= now)
  //             OR (status='running' AND claimed_at < now - leaseTimeout)   -- reclaim crashed
  // ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT $limit
  // then UPDATE status='running', claimed_at=now, attempts=attempts+1 RETURNING *

completeJob(workerTx, jobId)                       -> status='done'
failJob(workerTx, jobId, error, { now, backoff })  ->
  // attempts >= max_attempts ? status='failed' (dead)
  //   : status='pending', run_at = now + backoff(attempts), last_error=error
```

`claimDue` claims *and* transitions to `running` in one transaction so `SKIP LOCKED` guarantees no
two workers grab the same job. Backoff is exponential with a cap
(`min(2^attempts * base, cap)`), computed in TS from `attempts`.

**`src/jobs/handlers.ts`** — a registry mapping `type -> async (tx, ctx, payload) => void`. Keeps
the worker loop generic; C-recurring later registers `'recurring_generate'` without touching the
loop.

**`src/jobs/worker.ts`** + **`npm run worker`** (root `package.json`, same
`node --env-file=.env --import tsx` pattern as `migrate`/`seed`):

```
loop forever:
  jobs = claimDue(workerPool, { now, leaseTimeout: 5min, limit: N })
  if empty: sleep(pollInterval ~15s); continue
  for each job (concurrency-limited):
    ctx = { firmId: job.firm_id, clientCompanyId: job.client_company_id,
            actorId: 'system', actorRole: 'system' }        // synthetic worker context
    try:
      await withTenant(ctx, tx => handlers[job.type](tx, ctx, job.payload))   // appPool, RLS-bound
      await withWorker(wtx => completeJob(wtx, job.id))                       // workerPool
    catch e:
      await withWorker(wtx => failJob(wtx, job.id, e, { now, backoff }))
```

Seams:
- **`workerPool` + `withWorker`** — a new pool on `WORKER_DATABASE_URL` and a transaction wrapper
  mirroring `withTenant`, added to `src/db/pool.ts`.
- **System `TenantContext`** — the worker has no user session, so it uses a synthetic actor
  (`actorId: 'system'`, `actorRole: 'system'`; there is precedent — `actorId: 'agent'`). Audit
  rows from job handlers attribute to this system actor, which is correct: auto-generated work is
  visibly system-attributed. Confirm at plan time that no handler or `appendAudit` path rejects an
  unknown `actorRole`.
- **Graceful shutdown** — SIGTERM stops claiming and lets in-flight jobs finish; bounded poll
  interval.

## First consumer — dunning on the queue (+ folded slice-B follow-ups)

Migrating dunning proves the seam end-to-end and closes both follow-ups deferred on PR #4.

**Register `'dunning_run'`:**
```
handlers['dunning_run'] = async (tx, ctx, payload) => {
  const asOf = payload.asOf ?? todayUtc();          // reuse dunning's UTC-midnight day math
  await runDunning(tx, ctx, { asOf });
  await enqueue(tx, ctx, {                            // self-perpetuate: tomorrow, deduped on date
    type: 'dunning_run',
    runAt: nextUtcMidnight(asOf),
    dedupKey: `dunning:${nextDay(asOf)}`,
  });
};
```
One seed job per client becomes a daily chain: each run idempotent (dedup key = the date), each
enqueuing the next.

**Seeding.** Enabling a client's dunning policy (`setDunningPolicy`) enqueues the first
`dunning_run` (deduped, so toggling on/off/on can't stack duplicates). A one-time backfill in the
migration enqueues a `dunning_run` for every client that *already* has dunning enabled, so existing
tenants start without manual action.

**Folded slice-B follow-ups (both explicitly deferred to when a scheduler exists):**
1. **`dunning_events` insert → `ON CONFLICT (client_company_id, einvoice_id, level) DO NOTHING
   RETURNING`**, event-first then `createTask`. This is **load-bearing** now: the whole
   at-least-once posture depends on `runDunning` being genuinely idempotent so a retried/overlapping
   run can't duplicate tasks or abort mid-run.
2. **Route-boundary range validation** on the dunning routes (non-negative days/bps/flat → clean
   `400`s per the design's Zod intent).

**The manual `POST …/dunning/run` route stays** — still useful for on-demand/backfill runs and
tests. The queue adds the *scheduled* path; both call the same `runDunning`.

## Testing

All tests run against the real Postgres (`vitest run`, existing DB harness). New under
`tests/jobs/`.

**Queue primitives (`tests/jobs/queue.test.ts`):**
- `enqueue` inserts; a second `enqueue` with the same `dedup_key` is a no-op (`{ deduped: true }`),
  not a duplicate row or an error.
- `claimDue` returns only `pending` jobs with `run_at <= now`; transitions them to `running` with
  `attempts+1` and a `claimed_at`.
- **`SKIP LOCKED` concurrency:** two overlapping `claimDue` calls (two connections) never return the
  same job — the crux of at-least-once safety.
- **Lease reclaim:** a `running` job with a stale `claimed_at` is re-claimed; a fresh one is not.
- `failJob` under `max_attempts`: back to `pending` with a future `run_at` (backoff) and
  `last_error`; at `max_attempts`: terminal `failed`, never re-runs. `completeJob`: terminal `done`.

**RLS boundary (`tests/jobs/rls.test.ts`)** — guards the Section-1 carve-out:
- A `bookkeeping_app` connection scoped to tenant A sees only tenant A's jobs.
- A `bookkeeping_worker` connection sees jobs across all tenants.
- `bookkeeping_worker` has **no** privilege on a business table (e.g. `SELECT` on `einvoices` is
  denied).

**Worker + dunning integration (`tests/jobs/dunning-job.test.ts`):**
- A seeded `dunning_run`, when drained, calls `runDunning` under the right tenant and **enqueues
  tomorrow's job**.
- **Idempotency end-to-end:** running the same `dunning_run` twice (simulating at-least-once
  redelivery) produces dunning events/tasks **once** — exercises the `ON CONFLICT DO NOTHING` fix.
- Enabling a dunning policy seeds exactly one job; toggling off/on doesn't stack duplicates.
- Route range validation: negative days/bps/flat → `400` (extend `tests/dunning/routes.test.ts`).

**Deliberate coverage boundary:** the infinite worker *loop* (timers/process lifecycle) is not
tested end-to-end — it's awkward to test deterministically. Instead `claimDue` + handler dispatch +
`completeJob`/`failJob` are tested as units and one drain cycle is driven explicitly.

## Scope summary

| Piece | What |
|---|---|
| Role | New `bookkeeping_worker` login; only `SELECT,UPDATE` on `jobs`; explicit `USING(true)` policy for cross-tenant claim |
| Schema | `034_jobs.sql` — `jobs` table, dedup unique index, claim index, dual RLS policies, `firm_id`, retained terminal jobs |
| Domain | `src/jobs/` — `enqueue`/`claimDue`/`completeJob`/`failJob`, handler registry, `worker.ts` + `npm run worker`; `workerPool`/`withWorker` + system `TenantContext` |
| First consumer | Dunning → `'dunning_run'` self-perpetuating job; seed on policy-enable + migration backfill; both slice-B follow-ups folded in (ON CONFLICT idempotency #1 + route validation #2) |
| Posture | At-least-once + idempotent handlers; lease-based reclaim; graceful SIGTERM shutdown; control-plane RLS carve-out documented + tested |
| Tests | Queue primitives, RLS boundary, SKIP-LOCKED concurrency, lease reclaim, dunning-job idempotency + self-perpetuation, route validation |
| Deferred | Job retention/prune; C-recurring (`'recurring_generate'` type + templates + CRUD + UI) as a separate spec |
| Branching | Off `m4b-dunning` (needs slice A + the dunning code to migrate); C-recurring stacks on C-infra |

## House conventions (unchanged)

`migration + domain (src/<module>/) + tests + API route + page`; RLS via `withTenant`, never
bypassed (the `jobs` control-plane carve-out is the one documented, test-guarded exception); ledger
append-only; integer cents; i18n in all three catalogs (`web/app/lib/i18n.ts`) for any user-facing
strings; external systems behind an adapter interface with a stub. Modified Next.js — read
`web/node_modules/next/dist/docs/` before touching `web/` (`web/AGENTS.md`). Recommended delivery:
`superpowers:writing-plans` → `subagent-driven-development`.

# Chain reaper / supervisor — design

Date: 2026-07-14. Slice: M4 C-infra follow-up (the **required blocker** before C-recurring).
Status: approved, ready for `writing-plans`.

## Problem

The job queue's self-perpetuating chains have a single point of failure. A chain (e.g. dunning's
daily `dunning_run`) advances only because a **successful** run of period D enqueues period D+1:

- `worker.ts` runs the handler in a tenant tx (which enqueues the successor) and then
  `completeJob` in a separate worker tx. The **success** path reliably enqueues the successor.
- On failure the whole tenant tx rolls back, so **the successor is never enqueued**. At
  `max_attempts` the job goes terminal `failed` and the chain is dead.
- Recovery is fragile: `enqueueDunningRun` on policy re-enable uses dedup key `dunning:<today>`;
  if a job for that date already exists in **any** status (including `failed`),
  `ON CONFLICT DO NOTHING` swallows the re-seed. Only re-enabling on a fresh date restarts it.
- Separately, the `dunning_run` handler perpetuates the chain **even when the policy is disabled**
  (`runDunning` no-ops but still enqueues tomorrow), so `jobs` grows ~one row per enabled client
  per day, unbounded.

For dunning this is low-stakes (informational bookkeeper tasks). **C-recurring rides the identical
mechanism for money-out invoices, where a silently-dead chain means unbilled revenue — so the
reaper is a hard prerequisite.**

## Goal

Guarantee the invariant: **every active driver (enabled dunning policy; later, active recurring
template) has a live `pending`/`running` job.** Recover never-seeded chains, terminal-`failed`
chains, and re-enables; stop perpetuating disabled chains so `jobs` growth is capped.

## Decisions (from brainstorming)

1. **Recovery model = supervisor sweep.** A periodic cross-tenant sweep re-seeds any active driver
   lacking a live job. Idempotent via the existing dedup keys. Chosen over lightweight
   status-aware-dedup + fail-forward because it directly delivers the liveness invariant and
   subsumes the growth-cap fix (inactive drivers are simply not seeded).
2. **Privilege model = dedicated supervisor role.** A new least-privilege `bookkeeping_supervisor`
   login role, rather than widening `bookkeeping_worker` or running as the admin superuser. Keeps
   the job-transition worker role minimal and gives the reap path its own auditable capability,
   consistent with C-infra's least-privilege carve-out.

## Architecture

### New role: `bookkeeping_supervisor`

Trusted **control-plane** code, separate from the tenant-scoped app role and the job-transition
worker role. Grants:

- `SELECT` on `dunning_policy`, `client_companies` (to resolve `firm_id` for the seed insert), and
  `jobs`.
- `INSERT` on `jobs`.

RLS: a `USING(true)` supervisor policy on `dunning_policy`, `client_companies`, and `jobs`
(mirroring the worker's `jobs_worker_all` carve-out). `UPDATE` on `jobs` is **deliberately not
granted** — dunning's reaper only inserts. C-recurring adds `UPDATE` if it needs to reset a failed
period.

### Connection: `withSupervisor`

`src/db/pool.ts` gains `supervisorPool` (on `SUPERVISOR_DATABASE_URL`) and `withSupervisor(fn)` — a
transaction like `withWorker`, setting **no** tenant session var. `closeDb` (tests) and the worker
`main()` shutdown end it.

### Reaper mechanism: worker-driven sweep + reaper registry

Following C-infra's "no external cron" decision, the reaper runs **inside the worker loop**,
throttled by `REAP_INTERVAL_MS` (default 60_000; dunning is daily, so cadence is generous). It is
exposed as a testable **`reapOnce({now})`**, parallel to `drainOnce`.

A **reaper registry** parallels the handler registry: `registerReaper(fn)` where
`fn(tx, {now}) => Promise<{ seeded: number }>` runs on the supervisor tx. `reapOnce` opens one
`withSupervisor` tx and invokes each registered reaper. `src/jobs/register.ts` registers
`reapDunning`. Each feature's recovery semantics live with its handler; the generic reaper just
iterates. **C-recurring registers its own reaper the same way.**

## Dunning reap semantics

`reapDunning` is migration 035's seed logic as a periodic, idempotent sweep, guarded by a
`NOT EXISTS(live job)` check:

```sql
INSERT INTO jobs (client_company_id, firm_id, type, run_at, payload, dedup_key)
SELECT c.id, c.firm_id, 'dunning_run', $now, jsonb_build_object('asOf', $today), 'dunning:' || $today
  FROM client_companies c
  JOIN dunning_policy p ON p.client_company_id = c.id
 WHERE p.enabled = true
   AND NOT EXISTS (SELECT 1 FROM jobs j
                    WHERE j.client_company_id = c.id AND j.type = 'dunning_run'
                      AND j.status IN ('pending','running'))
ON CONFLICT (client_company_id, type, dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING;
```

`$today` = UTC calendar day of `now` (reuse `utcMidnight`); `$now` = the run-at timestamp.

Recovery cases:
- **Never seeded** → seeded.
- **Terminal-`failed` chain** whose only rows are `failed`/`done` in the past → today's run is
  seeded and the chain revives.
- **Edge — today's job already `failed`:** the insert deduplicates (the `dunning:<today>` row
  exists), so the chain self-heals on the next date rollover. This **≤1-day recovery window is
  acceptable for dunning** (low-stakes, informational). C-recurring needs stronger
  retry-the-missed-period semantics; the mechanism supports it once `UPDATE` on `jobs` is granted —
  explicitly out of scope here.

## Growth-cap fix (stop perpetuating when disabled)

`runDunning` already no-ops when the policy is disabled, but the `dunning_run` handler perpetuates
unconditionally. Fix: `runDunning` returns `enabled` in its result; the handler enqueues tomorrow
**only when `enabled`**. Disabled chains stop growing; the reaper and the policy-PUT re-seed on
re-enable. Retention/prune of terminal `done` rows for *enabled* clients stays deferred (tracked
follow-up).

## Files

- **`migrations/036_supervisor_role.sql`** — role (idempotent create like 034; roles survive
  `resetDb`, grants/policies re-applied on re-run), grants, RLS policies. Next free migration is
  036.
- `src/db/pool.ts` — `supervisorPool` + `withSupervisor`; end it in `closeDb` and worker shutdown.
- `src/jobs/reapers.ts` — `registerReaper`/`getReapers`, `reapOnce({now})`.
- `src/jobs/worker.ts` — wire `reapOnce` into `main()` at `REAP_INTERVAL_MS`.
- `src/jobs/register.ts` — register `reapDunning`; make `dunning_run` perpetuation conditional.
- `src/dunning/reap.ts` — `reapDunning`.
- `src/dunning/dunning.ts` — `runDunning` result gains `enabled: boolean`.
- `.env.example` — `SUPERVISOR_DATABASE_URL=postgres://bookkeeping_supervisor:supervisor_pw@localhost:5433/bookkeeping`.

## Testing

- `tests/jobs/reaper.test.ts`:
  - enabled + no live job → seeds today's `dunning_run`;
  - enabled + live `pending` job → no-op (idempotent);
  - disabled policy → no-op;
  - terminal-`failed` chain with only past rows → revived (today seeded);
  - `failed` job dated today → no-op that turn (documents the ≤1-day window).
- Supervisor RLS (extend `tests/jobs/rls.test.ts` or a new file): supervisor can `SELECT`
  `dunning_policy`/`client_companies`/`jobs` and `INSERT` `jobs`, and **cannot** read/write other
  business tables (negative test).
- Growth-cap: draining a `dunning_run` under a **disabled** policy leaves **no** successor job;
  under an **enabled** policy leaves exactly one.
- Full suite stays green (currently 386).

## Scope boundary

Delivers **shared reaper infra + dunning's reaper**. Does **not** build C-recurring's reaper,
retry-the-missed-period semantics, or `jobs` retention/prune — those belong to C-recurring or remain
tracked follow-ups.

## House conventions

`migration + domain (src/<module>/) + tests`; RLS via role policies, never bypassed (the supervisor
`USING(true)` policies are documented control-plane carve-outs, like the worker's); at-least-once
queue → handlers and reapers must be idempotent; integer cents; external systems behind adapters.
Delivery: `writing-plans → subagent-driven-development`.

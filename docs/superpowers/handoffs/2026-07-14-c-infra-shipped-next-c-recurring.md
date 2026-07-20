# Handoff — M4 slice C-infra shipped; next is C-recurring

Date: 2026-07-14. Author: session that built C-infra (job queue + worker). Status: **C-infra
complete & pushed; C-recurring not started — ready to brainstorm.**

## What just shipped: C-infra (durable job queue + worker)

The scheduler gap that blocked recurring invoices (and kept slice B's dunning manual-trigger) is
now closed. We chose the **robust** path over the original handoff's external-cron recommendation:
a **durable Postgres job queue drained by a standalone worker process**, with per-job retries,
backoff, lease-based reclaim, and idempotent handlers. It was split from the recurring feature into
its own spec/PR, and **dunning was migrated onto it as the first consumer**.

- Spec: `docs/superpowers/specs/2026-07-14-job-queue-infra-design.md`
- Plan: `docs/superpowers/plans/2026-07-14-job-queue-infra.md`
- Delivered via `brainstorming → writing-plans → subagent-driven-development` (7 TDD tasks + final
  whole-branch review). Full suite **386/386**, typecheck clean.

**Where it lives:** merged (fast-forward) into **`m4b-dunning`** at commit `7931a7f` and pushed.
Because we merged into `m4b-dunning` rather than opening a stacked PR #5, **PR #4 now contains
slice B *and* C-infra** (22 commits). PR #4's title still says "AR dunning slice B" — update it if
you want it to reflect both.

### What C-infra added (the seams C-recurring will reuse)

- **`migrations/034_jobs.sql`** — `jobs` control-plane table + new least-privilege
  `bookkeeping_worker` login role. Dual RLS policies: standard tenant-isolation `TO
  bookkeeping_app` (enqueue + read own) and `USING(true) TO bookkeeping_worker` (cross-tenant
  claim). `FORCE RLS`; worker granted only `SELECT,UPDATE` on `jobs`, no business-table access.
  This is the one **documented, test-guarded carve-out** from "RLS everywhere" (the queue is
  control-plane; tenant isolation on business writes is enforced at execution time via
  `withTenant`).
- **`migrations/035_dunning_jobs_backfill.sql`** — one-time seed of a `dunning_run` per
  already-enabled client. (Next free migration number is **036**.)
- **`src/db/pool.ts`** — added `workerPool` (on `WORKER_DATABASE_URL`) + `withWorker(fn)` (worker
  transaction, does NOT set the tenant var).
- **`src/jobs/queue.ts`** — `enqueue(tx, ctx, {type, runAt, payload?, dedupKey?, maxAttempts?})`
  (tenant path, idempotent on `(client_company_id, type, dedup_key)` — note the partial unique
  index needs `WHERE dedup_key IS NOT NULL` repeated in any raw `ON CONFLICT`); `claimDue(tx,
  {now, leaseTimeoutMs, limit})`, `completeJob`, `failJob`, `backoffMs` (worker path).
- **`src/jobs/handlers.ts`** — `registerHandler(type, fn)` / `getHandler(type)`; `JobHandler = (tx,
  ctx, payload) => Promise<void>`.
- **`src/jobs/worker.ts`** — `drainOnce({now, leaseTimeoutMs, limit})` (testable single cycle),
  `workerCtx(job)` (synthetic `{actorId:'system', actorRole:'system'}` from the job's
  firm/client), and the `main()` loop. Runs via **`npm run worker`**.
- **`src/jobs/register.ts`** — registers production handlers as an import side effect. Currently
  registers **`dunning_run`** (runs `runDunning`, then self-perpetuates by enqueuing the next day,
  deduped on `dunning:<date>`). **This is the exact pattern C-recurring's `recurring_generate`
  should mirror.**
- **`src/dunning/schedule.ts`** — `utcMidnight`, `nextDay`, `enqueueDunningRun`.
- Folded in both slice-B pre-scheduler follow-ups: dunning `dunning_events` insert is now
  **event-first `ON CONFLICT DO NOTHING RETURNING`** (idempotent under at-least-once redelivery),
  and dunning routes reject negative days/bps/flat (clean 400s).

**Operational notes:** add `WORKER_DATABASE_URL=postgres://bookkeeping_worker:worker_pw@localhost:5433/bookkeeping`
to `.env` (already in `.env.example`). The worker role is created by migration 034 and persists
across `resetDb()`. Start the worker with `npm run worker`. Delivery is **at-least-once** — every
handler MUST be idempotent (this is load-bearing, not optional).

## ⚠️ BLOCKER for C-recurring: build a chain reaper/supervisor FIRST

The final review surfaced one Important robustness gap (decision this session: **track, don't build
here**). It is documented in the C-infra spec under "Known follow-ups" and is **REQUIRED before
C-recurring**:

The self-perpetuating chain means the **only** thing that enqueues day D+1 is a **successful** run
of day D. If a handler fails deterministically (code bug, data condition) the job exhausts retries,
goes terminal `failed`, and **the chain dies with no recovery** — and re-enabling the policy will
NOT restart it (the `<key>:<D>` dedup row blocks re-seeding across all statuses, including
`failed`). For dunning today this is low-stakes (informational bookkeeper tasks). For C-recurring it
is **unacceptable** — a silently-dead chain means unbilled money-out invoices.

Build a reaper/supervisor before (or as the first task of) C-recurring. Sketch of options to
brainstorm:
- A periodic sweep that guarantees every active template/enabled client has a `pending` job, and
  re-seeds a dropped chain; and/or
- A status-aware dedup (exclude terminal `failed` rows) so re-enable/re-activate restarts a dead
  chain; and/or
- Stop perpetuating when the policy/template is inactive (also caps unbounded `jobs` growth — see
  minor follow-ups).

This reaper is shared infra, so it belongs with the queue, not buried in the recurring feature.

## Next work: C-recurring (recurring / subscription invoices)

This is the feature the original handoff (`2026-07-14-slice-c-recurring-invoices.md`) was about;
C-infra was the extracted foundation. C-recurring now has a scheduler to ride. It stacks on the
job-queue infra (currently on `m4b-dunning`; branch off wherever the queue code lives when you
start — confirm PR #4's merge state).

Grounded starting sketch (refine in a `superpowers:brainstorming` session → spec → plan):
- **Reaper first** (see blocker above).
- **Migration `036`** (or later): `recurring_invoice_templates` — `id`, `client_company_id`,
  `customer_party_id`, the invoice template payload (JSONB vs child table — decide), `cadence`,
  anchor (day-of-month), `next_run_date`, `payment_terms_days` (or inherit customer's), `active`,
  `end_date`/`occurrences_remaining`. Full RLS mirroring `032_receivables.sql`.
- **Domain `src/recurring/`**: `generateDueRecurringInvoices` / a `recurring_generate` job handler
  registered in `src/jobs/register.ts`, mirroring the `dunning_run` self-perpetuation pattern.
  Reuse slice A's `sendInvoice` (`src/einvoice/outbound.ts`, signature now takes
  `customerPartyId?`/`dueDate?`) — do **not** reimplement invoice creation. Generated invoices are
  born as `open` receivables and flow into `arAging` + dunning automatically. Idempotency: dedup
  key `<templateId>:<period>` (the `jobs` unique index already supports this).
- Template CRUD routes + a management screen; enqueue the first job on template creation.

### Open questions still to resolve for C-recurring (deferred from this session)

These were intentionally NOT decided during C-infra because they don't affect the queue:
1. **Approval posture** — auto-issue recurring invoices directly (like slice A), or gate via
   `autonomy_policy` (`src/autonomy/`, likely a new `recurring_invoice` operation type,
   default-closed)? Auto-issuing money-out documents unattended is a trust decision.
2. **Peppol send on generation** — transmit immediately via the `AccessPoint`, or generate-then-hold
   for review? Interacts with (1).
3. **Cadence model** — enums (monthly/quarterly/annual) vs interval-days vs cron vs
   anchor-day-of-month. Start simple.
4. **End conditions** — end date / N occurrences / indefinite (cheap to support all).
5. **Mid-stream edits** — future-runs-only is the standard answer; confirm price/VAT-over-time.
6. **Timezone** — reuse the UTC day math already in `src/dunning/dunning.ts` /
   `src/dunning/schedule.ts` (`utcMidnight`/`nextDay`).
7. **Catch-up semantics** — if the worker was down or a template is created with a past
   `next_run_date`, generate one invoice or backfill every missed period?

## Minor tracked follow-ups (non-blocking, from the C-infra review)

- Perpetuation continues even when a policy is disabled → `jobs` grows ~one retained row per
  enabled client per day; no prune (retention/prune deliberately deferred). Fix alongside the
  reaper.
- Policy validation throws a raw `SyntaxError` (still HTTP 400 via `errorToStatus`, just a less-clean
  message) if `lateFeeFlatCents` is non-numeric garbage.

## House conventions (unchanged)

`migration + domain (src/<module>/) + tests + API route + page`; RLS via `withTenant`, never
bypassed (the `jobs` control-plane carve-out is the one documented, test-guarded exception);
at-least-once queue → **handlers must be idempotent**; ledger append-only; integer cents; i18n in
all three catalogs (`web/app/lib/i18n.ts`) for user-facing strings; external systems behind an
adapter interface with a stub. Modified Next.js — read `web/node_modules/next/dist/docs/` before
touching `web/` (`web/AGENTS.md`). Recommended delivery: `brainstorming → writing-plans →
subagent-driven-development`.

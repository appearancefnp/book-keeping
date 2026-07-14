# Handoff — M4 slice C: recurring / subscription invoices

Date: 2026-07-14. Author: prior session (AR slices A-UI + B). Status: **not started — ready to brainstorm.**

This is a handoff, not a design. It captures the current state, the one decision that gates
slice C (a **scheduler**), a grounded starting sketch, and the open questions to resolve in a
`superpowers:brainstorming` session before writing a spec.

## Where slice C sits

M4 "AR lifecycle" is being delivered in slices (`docs/ROADMAP-market-gaps.md`):
- **A — money-in loop** — shipped (PR #2 `m4a-ar-money-in-loop`): open-item tracking on
  outbound `einvoices` (`status`/`due_date`/`amount_paid_cents`), `settleReceivable`, `arAging`,
  invoice-linked bank matching, per-customer `payment_terms_days`.
- **A-UI** — shipped (PR #3 `m4a-ui-settle`, stacked on #2): `/invoices` payment columns +
  settle/void drawer.
- **B — dunning + late fees** — shipped (PR #4 `m4b-dunning`, stacked on #2): `src/dunning/`
  per-client policy + escalation stages + informational late fees + `runDunning` emitting
  bookkeeper tasks, exposed via a **manually-triggered, cron-ready** route.
- **C — recurring invoices (THIS)** — ⛔.
- **D — quotes→invoice**, **customer statement view** — ⛔ (independent of C).

Specs/plans to read first: `docs/superpowers/specs/2026-07-13-ar-money-in-loop-design.md`,
`docs/superpowers/specs/2026-07-14-ar-dunning-design.md`, and the matching plans in
`docs/superpowers/plans/`.

**Branching:** once PR #2 merges to `main`, branch slice C off `main`. Until then, branch off
`m4a-ar-money-in-loop` (slice C needs slice A's `sendInvoice` issue-path changes and the
receivables read model, which are only on that branch). Slice C does **not** depend on #3 or #4.

## The gating decision: a scheduler

Recurring invoices need something to fire on a schedule and generate invoices when due. **The
codebase has no scheduler, cron, or job queue today** (grep-confirmed). This same gap is why
slice B's dunning is manual-trigger. Resolving it unblocks both: recurring generation **and**
auto-running dunning.

Options (decide in brainstorming):
1. **External cron → one authenticated "tick" route (recommended starting position).** A
   deployment-level scheduler (Vercel Cron, GitHub Actions, or system cron) POSTs to a single
   authenticated route, e.g. `POST /api/cron/run-due`, which generates due recurring invoices
   **and** runs dunning. Smallest durable option; keeps the scheduler external behind a route
   seam exactly like the existing `AccessPoint`/`VidClient` stub pattern and the cron-ready
   `POST /api/receivables/dunning/run`. No new runtime infra.
2. **Durable job queue / workflow** (a `jobs` table + worker, or Vercel Workflow/WDK) — more
   robust (retries, backoff, per-job idempotency) but materially more infra to stand up.
3. **In-process timer** (`node-cron`/`setInterval`) — rejected: the web tier is Next.js/
   serverless-shaped; an in-process timer is not durable and won't run reliably.

Recommendation: **Option 1** for slice C — one authenticated tick route that fans out to
recurring-generation + dunning, driven by an external cron chosen at deploy time. Revisit
Option 2 only if retry/idempotency needs outgrow a single transactional run.

Auth for the tick route: it runs without a user session, so it needs a service-auth path
(shared secret / signed header) distinct from `getSessionToken`. **This is new surface** — call
it out in the spec; check `src/auth/` for an existing machine-auth seam before inventing one.

## Grounded starting sketch (for the spec to refine)

Reuse slice A's issue path — do **not** reimplement invoice creation.

- **Migration `034`** (highest existing is `033_dunning.sql`). Full RLS mirroring
  `032_receivables.sql`/`012_autonomy_policy.sql` (ENABLE+FORCE, `_tenant_isolation` policy on
  `current_setting('app.current_client_id', true)::uuid`, grants to `bookkeeping_app`).
  - `recurring_invoice_templates`: `id`, `client_company_id`, `customer_party_id`, the invoice
    template payload (lines/amounts/VAT — decide JSONB vs child table), `cadence`
    (monthly/quarterly/annual/interval-days), anchor (e.g. day-of-month), `next_run_date`,
    `payment_terms_days` (or inherit the customer's), `active`, `end_date`/`occurrences_remaining`.
  - Idempotency: a `recurring_runs` (or `generated_invoices`) link table, unique on
    `(template_id, period)`, so a re-run never double-issues for the same period. (Slice B's
    `dunning_events` unique-key idempotency is the pattern to copy — and note slice B's tracked
    follow-up to switch its insert to `ON CONFLICT DO NOTHING`; apply that pattern here from the
    start.)
- **Domain `src/recurring/`**:
  - `generateDueRecurringInvoices(tx, ctx, { asOf }) → summary`: find `active` templates with
    `next_run_date <= asOf`; for each, if not already generated for the period, call the
    existing `sendInvoice` (`src/einvoice/outbound.ts`) with the template payload +
    `customerPartyId` + a `dueDate` computed from payment terms, record the generation, and
    advance `next_run_date` by cadence. Because it reuses `sendInvoice`, generated invoices are
    born as `open` receivables and flow into `arAging` + dunning automatically.
  - `sendInvoice` today takes `{ invoice, recipientPeppolId, ap, receivableAccount, salesAccount,
    vatAccount, customerPartyId, dueDate }` — confirm the exact signature at build time.
- **Routes/UI**: template CRUD routes + a templates management screen (likely a new
  `/invoices`-area page or tab); the tick route from the scheduler decision above.
- **Tests**: cadence advance + idempotency (no double-issue per period), end-date/occurrence
  termination, `active=false` skip, and that a generated invoice appears as an open receivable.

## Open questions to resolve in brainstorming

1. **Approval posture.** Slice A issues invoices directly (not proposal-gated). Should
   auto-generated recurring invoices issue directly, or land in the approval queue / respect an
   `autonomy_policy` entry (`src/autonomy/`)? Auto-issuing money-out documents unattended is a
   trust decision — likely wants at least an autonomy toggle.
2. **Peppol send on generation.** `sendInvoice` transmits via the `AccessPoint`. Do recurring
   runs send immediately, or generate-then-hold for review? Interacts with (1).
3. **Cadence model.** Fixed enums (monthly/quarterly/annual) vs interval-days vs a cron-style
   expression vs anchor-day-of-month. Start simple.
4. **End conditions.** End date, N occurrences, or indefinite.
5. **Mid-stream edits.** Editing a template's amounts/lines; do changes apply to future runs
   only? Price/VAT changes over time.
6. **Timezone / "due".** How `asOf` and `next_run_date` handle timezones (dunning uses UTC-midnight
   day math in `src/dunning/dunning.ts` — reuse that helper for consistency).
7. **Catch-up semantics.** If the cron misses a day (or a template is created with a past
   `next_run_date`), does one run generate one invoice or backfill each missed period?

## Also fold in while wiring the shared cron (slice B pre-scheduler follow-ups)

These were deliberately deferred from slice B and become relevant the moment a scheduler exists
(they are recorded on PR #4):
- Switch `dunning_events` insert to `ON CONFLICT (client_company_id, einvoice_id, level) DO
  NOTHING RETURNING` (event-first, then `createTask`) so concurrent/overlapping runs can't
  duplicate tasks or abort the whole run.
- Add route-boundary range validation (non-negative days/bps/flat) to the dunning routes per the
  design's Zod intent (clean 400s instead of 500s).

## House conventions (unchanged)

`migration + domain (src/<module>/) + tests + API route + page`; RLS via `withTenant`, never
bypassed; ledger append-only; integer cents; i18n in all three catalogs (`web/app/lib/i18n.ts`);
external systems behind an adapter interface with a stub. Modified Next.js — read
`web/node_modules/next/dist/docs/` before touching `web/` (`web/AGENTS.md`). Recommended delivery:
`superpowers:brainstorming` → `writing-plans` → `subagent-driven-development`, as slices A-UI and B
were built this session.

# M4 integration — land slices A, A-UI, B (+ jobs infra) onto main

Date: 2026-07-19. Status: approved for planning.

## Problem

The M4 AR-lifecycle workstream lives on three unmerged branches, all forked from
main @ `dc9a0df` (2026-07-13) and last touched 2026-07-14:

- `m4a-ar-money-in-loop` (PR #2 → main) — receivables read model on outbound
  `einvoices` (`customer_party_id`, `due_date`, `amount_paid_cents`, `status`),
  `settleReceivable`, invoice-linked AR bank matching, `arAging` +
  `/api/reports/ar-aging` + aged-receivables tab, per-customer
  `payment_terms_days`. Migration `032_receivables.sql`.
- `m4a-ui-settle` (PR #3, stacked on A) — `/invoices` payment/status columns +
  settle/void drawer.
- `m4b-dunning` (PR #4, stacked on A, sibling of A-UI) — `src/dunning/` policy +
  escalation stages + informational late fees + `runDunning`; **plus C-infra**:
  a durable job queue (`jobs` table, `bookkeeping_worker` role, handler
  registry, `drainOnce`, standalone worker loop) and a chain reaper with
  `bookkeeping_supervisor` role. Migrations `033`–`036`.
- PR #5 — slice-C (recurring invoices) handoff doc only.

Meanwhile main moved on: M7 credit notes (2026-07-17), M14 report depth +
export (2026-07-18), M3 bank feeds + the production-hardening batch
(2026-07-19). This produced textual conflicts, migration-number collisions
(both sides used 032–036), and one semantic gap (credit notes × the AR
open-item model). The M4 branches were reviewed by the standard pipeline
before the pause; the integration must land them without re-doing that work,
while reconciling them with what main gained since.

## Approach

A local integration branch `m4-integration` off main. Sequential merges,
resolving conflicts once per slice, then one merge to main + push:

1. `git merge origin/m4a-ar-money-in-loop`
2. `git merge origin/m4a-ui-settle`
3. `git merge origin/m4b-dunning`

Rejected alternatives: rebasing each branch onto main (3× conflict resolution
across ~40 commits, migration renumber woven through history) and
squash-merging (loses the reviewed per-commit history). Sequential merge
matches how this repo has always landed feature branches.

## Mechanical reconciliation

- **Migration renumbering** (main's max is `036`; the CI numbering test
  enforces no collisions): `032_receivables` → `037`, `033_dunning` → `038`,
  `034_jobs` → `039`, `035_dunning_jobs_backfill` → `040`,
  `036_supervisor_role` → `041`. No column clashes — main's
  `032_credit_notes` and the branch's receivables migration alter different
  `einvoices` columns. Grep the branch code/docs for references to the old
  filenames after renaming.
- **`src/einvoice/outbound.ts` / `query.ts`**: merge main's zero-VAT line
  handling + `sendCreditNote` + `doc_type` with the branch's
  `customerPartyId` / `dueDate` / `status='open'` persistence on
  `sendInvoice`. Credit-note rows keep `status` NULL so they never surface as
  receivables themselves.
- **errorToStatus**: the branch's new routes predate main's shared
  `errorToStatus` helper — adopt it in all routes the merge brings in
  (`/api/receivables/[id]`, `/api/reports/ar-aging`, dunning policy/run
  routes, and any jobs routes).
- **Role-gating**: add the new mutations to the `Operation` matrix
  (`src/authz/policy.ts`) and enforce at the route surface, mirroring bills:
  `receivables.settle` (covers settle + void) and `dunning.write` +
  `dunning.run` — accountant + firm_admin.
- **Textual merges**: `web/app/lib/i18n.ts` (both sides added keys — union),
  `/reports` page (main's GL/TB tabs + export buttons vs branch's AR-aging
  tab + dunning editor — keep all), `/invoices` pages (main's credit-note
  composer mode + doc-type column vs branch's status columns + settle
  drawer — keep all), `src/db/pool.ts` (main's max/timeout caps + branch's
  `workerPool`/`withWorker` — worker pool gets the same caps), `package.json`,
  `.env.example`, seed, docs.

## Semantic reconciliation: credit notes × receivables (decided: Option 2)

M7's `sendCreditNote` credits the GL receivable, but the branch's AR module
doesn't know credit notes exist. Unreconciled, a credited invoice stays fully
open in AR aging and **dunning keeps chasing the customer for it**.

- **Referenced credit notes apply against the invoice.** When
  `corrected_invoice_number` is set and resolves to an outbound invoice of the
  same client (lookup by `invoice_number`), record an application in
  `invoice_payments` with a new method `'credit_note'` (new migration
  `042_credit_note_applications.sql` — the renumbered `037`–`041` stay
  byte-identical to the reviewed branch content),
  amount capped at the invoice's outstanding, advancing
  `amount_paid_cents`/`status` exactly like `settleReceivable`. **No extra GL
  posting** — `sendCreditNote` already posted the reversal. If the reference
  doesn't resolve, treat as unreferenced (no error).
- **Unreferenced credit notes net into `arAging`** by their own issue-date
  age — the exact mirror of `apAging`'s applied-vendor-credit-note netting.
  Referenced (applied) credit notes must NOT also net into aging — their
  effect already lives in the invoice's reduced outstanding. Track
  applied-vs-unapplied via the `invoice_payments` application row.
- Edge cases: application amount = min(CN grand total, invoice outstanding);
  a CN larger than the outstanding applies partially and the remainder nets
  into aging as unapplied credit; a CN against an already-`paid`/`void`
  invoice is fully unapplied. Dedup: one application per credit-note einvoice,
  via a new `credit_note_einvoice_id uuid REFERENCES einvoices(id)` column on
  `invoice_payments` (also in `042`) with a partial unique index
  (`WHERE credit_note_einvoice_id IS NOT NULL`).
- Tests: referenced CN reduces outstanding + stops dunning for that invoice;
  unreferenced CN nets aging buckets; over-sized CN splits
  applied/unapplied; aging total ties to the GL receivable account balance
  in a mixed fixture.

## Jobs queue on Vercel (decided: include)

The branch's queue drains via a standalone worker loop, which never runs on
Vercel. Add `GET /api/cron/jobs-drain` mirroring the existing bank-sync cron
route (same cron-secret auth pattern, `maxDuration` set, Node runtime), calling
`drainOnce` (and the reaper's `reapOnce` per its explicit-enabled scope);
schedule it in `web/vercel.json`. The route needs the worker connection path —
`WORKER_DATABASE_URL` (name per the branch's `.env.example`) added to the web
env story in `docs/RUNNING.md`. The standalone worker remains for self-hosted
use. Timing-safe secret compare (the bank-sync route's non-timing-safe compare
is a known cosmetic — don't copy it; fix both while here).

## Docs & PR hygiene

- Merge PR #5's slice-C handoff doc as part of the integration; update its
  "branch off `m4a-ar-money-in-loop` until #2 merges" note (obsolete once
  merged) and its migration-number sketch (034 → next free after 041), and
  reflect that C-infra (queue + reaper) is now on main.
- Update `HANDOFF.md` + `docs/ROADMAP-market-gaps.md`: M4 → 🔶 (A, A-UI, B +
  C-infra shipped; C-recurring and D remain), M5 → ✅.
- After main is pushed: PR #2 auto-marks merged; retarget #3/#4 to main so
  GitHub marks them merged; close #5.

## Gates

Full backend suite (`npm test`, never concurrently with another suite),
`npx tsc --noEmit` in root and `web/`, web build, final whole-branch review
(workflow, high effort). On pass: merge `m4-integration` to main and push
(standing authorization). Surface review findings and judgment calls in the
final summary for veto.

## Out of scope

Slice C-recurring (next feature, per the updated handoff doc), slice D
(quotes→invoice, customer statements), per-client account-mapping settings
(existing debt), and any behavior change to the merged slices beyond the
reconciliations listed above.

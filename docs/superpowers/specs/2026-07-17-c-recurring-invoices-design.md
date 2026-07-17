# C-recurring: Recurring / Subscription Invoices — Design

Date: 2026-07-17. Branch: `m4b-dunning` (do NOT branch; commit directly). Slice C-recurring —
the feature the job queue (C-infra) and the chain reaper were the foundation for.

**Goal:** A recurring-invoice template, generated on schedule by the durable job queue, that reuses
`sendInvoice` (slice A) so generated invoices are born as `open` receivables and flow into AR aging
and dunning automatically — gated by the existing autonomy/proposals trust model, and made
self-healing by the chain reaper.

## Context this builds on (existing seams)

- **`dunning_run` handler** (`src/jobs/register.ts`) — generate-then-self-perpetuate, deduped on a
  `<key>:<period>` job dedup key, perpetuating only while the driver is enabled. `recurring_generate`
  mirrors this exactly.
- **`sendInvoice`** (`src/einvoice/outbound.ts`) — validates EN 16931, posts the receivable
  (DR receivable / CR sales / CR VAT), dispatches via the `AccessPoint`, records the einvoice born
  `status='open'`. Peppol send happens *inside* it. Signature already accepts
  `customerPartyId?`/`dueDate?`. **Reused, not reimplemented.**
- **`autonomy_policy`** (`src/autonomy/autonomy.ts`) — `resolveAutonomy(tx, ctx, operationType,
  {amountCents})` returns `'auto' | 'approval'`, default-closed, with a per-op material-threshold
  guardrail. The home for the "issue unattended?" decision.
- **`proposals`** (`src/proposals/proposals.ts`) — `createProposal({type, status:'pending_approval',
  payload, rationale})` surfaces items in the approvals inbox. `proposals.type` is CHECK-constrained
  (`011_proposals.sql`).
- **Reaper registry** (`src/jobs/reapers.ts`) — `registerReaper(fn)` + `reapOnce` sweep on the
  `bookkeeping_supervisor` pool. `reapDunning` (`src/dunning/reap.ts`) is the template to copy.
- **Invoice profile** (`src/einvoice/invoice-profile.ts`) — per-client `number_prefix`,
  `due_date_offset_days`, `note` used to shape generated invoices.
- **Parties** — `getParty` exposes `paymentTermsDays`; `dueDateFromTerms(issueDate, days)` computes a
  due date. Parties have **no** Peppol endpoint column, so the template must store its own.

Next free migration number: **037**.

## Decisions (resolved in brainstorming)

| Question | Decision |
|---|---|
| Approval posture | **Gate via autonomy** — new default-closed `recurring_invoice` op. `auto` (and under threshold) → auto-send; else create a `pending_approval` proposal an operator issues later. |
| Cadence model | **Anchor day-of-month + interval in months** (1/3/12 = monthly/quarterly/annual). |
| Catch-up semantics | **Skip to current period** — generate one invoice, advance `next_run_date` past all missed periods. |
| End conditions | **All three** — `end_date`, `occurrences_remaining`, indefinite (`active`). |
| Mid-stream edits | Future-runs-only — edits never touch already-issued invoices. |
| Timezone | Reuse the UTC day math in `src/dunning/schedule.ts`. |

## 1. Data model — `migrations/037_recurring_invoices.sql`

`recurring_invoice_templates` (full RLS mirroring `032_receivables.sql`: `ENABLE` + `FORCE ROW LEVEL
SECURITY`, tenant-isolation policy on `app.current_client_id`, `GRANT SELECT,INSERT,UPDATE TO
bookkeeping_app`):

- `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
- `client_company_id uuid NOT NULL REFERENCES client_companies(id)`
- `customer_party_id uuid NOT NULL REFERENCES parties(id)`
- `recipient_peppol_id text NOT NULL` — parties store no Peppol endpoint; `sendInvoice` requires it
- `invoice_payload jsonb NOT NULL` — the `EInvoice` **minus** per-run fields (`invoiceNumber`,
  `issueDate`, `dueDate`): `currency`, `supplier`, `customer`, `lines`, `netTotal`, `vatTotal`,
  `grandTotal`, `note`
- `anchor_day int NOT NULL CHECK (anchor_day BETWEEN 1 AND 31)`
- `interval_months int NOT NULL CHECK (interval_months > 0)`
- `next_run_date date NOT NULL`
- `payment_terms_days int` — nullable; falls back to the customer party's terms at generation
- `end_date date` — nullable
- `occurrences_remaining int` — nullable; NULL = unlimited
- `active boolean NOT NULL DEFAULT true`
- `created_at timestamptz NOT NULL DEFAULT now()`, `updated_at timestamptz NOT NULL DEFAULT now()`
- Index: `(client_company_id, active, next_run_date)` for the reaper/due sweep.

**Anchor-day clamping:** a 31 anchor in a 30-day month (or Feb) clamps to the month's last day
(`clampToMonth`, UTC).

**Supervisor access for the reaper** (in the same migration): `GRANT SELECT ON
recurring_invoice_templates TO bookkeeping_supervisor;` + a control-plane read policy
`CREATE POLICY recurring_templates_supervisor_read ... TO bookkeeping_supervisor USING (true);`
(mirrors `dunning_policy_supervisor_read` from `036_supervisor_role.sql`). Permissive policies are
OR-combined, so this re-opens cross-tenant read for the supervisor role only.

**Proposals type extension** (same migration or a paired one): extend the `proposals.type` CHECK to
add `'recurring_invoice'`, and extend `ProposalType` + the zod enum in `src/proposals/proposals.ts`.
(The immutability trigger in `011_proposals.sql` is unaffected.)

## 2. Invoice numbering

Deterministic per run: `${number_prefix ?? 'INV'}-${period}-${templateShortId}` where `period` is
`YYYY-MM` of the run date and `templateShortId` is the first 8 chars of the template id
(e.g. `REC-2026-05-a1b2c3d4`). Deterministic → idempotent (re-generating the same period yields the
same number) and collision-free across templates and periods.

**Limitation (accepted for MVP):** this is not gapless legal sequential numbering. A proper
per-client monotonic sequence is deferred and noted here as a known follow-up.

## 3. Domain — `src/recurring/`

**`recurring.ts`** — tenant-path CRUD + audit (mirrors `src/parties/parties.ts` style):
- `createTemplate(tx, ctx, input)` → `{ id }`; validates payload with zod; computes the initial
  `next_run_date` from `anchor_day`/`interval_months` relative to a supplied `from` date.
- `getTemplate`, `listTemplates(filter)`, `updateTemplate` (future-runs-only), `deactivateTemplate`.

**`schedule.ts`** — reuse/mirror `src/dunning/schedule.ts`:
- `clampToMonth(year, month, anchorDay): string` — YYYY-MM-DD, clamped to the month's last day.
- `advanceRunDate(isoDate, intervalMonths, anchorDay): string` — next occurrence date (UTC).
- `periodKey(isoDate): string` — `YYYY-MM`.
- `enqueueRecurringGenerate(tx, ctx, {templateId, period, runAt})` — deduped on
  `recurring:<templateId>:<period>`.

**`generate.ts`** — `generateDueRecurring(tx, ctx, {templateId, now}): Promise<{generated: boolean;
active: boolean}>`:
1. Load the template. If `!active` OR (`end_date` set AND `next_run_date > end_date`) OR
   (`occurrences_remaining === 0`) → return `{generated:false, active:false}` (stops perpetuation,
   mirrors dunning's `enabled` gate).
2. Build the `EInvoice` from `invoice_payload` + computed `invoiceNumber`, `issueDate`
   (= the due period date, i.e. `next_run_date`), `dueDate` (from `payment_terms_days` or the
   customer party's terms via `dueDateFromTerms`).
3. **Autonomy gate:** `resolveAutonomy(tx, ctx, 'recurring_invoice', {amountCents: grandTotalCents})`.
   - `auto` → `sendInvoice(tx, ctx, {invoice, recipientPeppolId, ap, ...accounts, customerPartyId,
     dueDate})` → born `open`.
   - `approval` → `createProposal(tx, ctx, {type:'recurring_invoice', status:'pending_approval',
     payload:{invoice, recipientPeppolId, customerPartyId, dueDate}, rationale:{...}})`.
4. **Advance (skip-to-current):** loop `advanceRunDate` until `next_run_date` is in the future;
   `UPDATE` the template's `next_run_date`; if `occurrences_remaining` is set, decrement by one
   (never below 0). Only one invoice/proposal is produced per call.
5. Return `{generated:true, active}` where `active` is false once the template has hit an end
   condition after this run (so the handler knows not to perpetuate).

`generate.ts` consumes `sendInvoice` — the AP instance is injected by the handler (production) or a
stub (tests), matching the einvoices route's `accessPoint` pattern.

## 4. Job wiring — `src/jobs/register.ts` + `src/recurring/reap.ts`

- `registerHandler('recurring_generate', async (tx, ctx, payload) => { const {active} =
  await generateDueRecurring(tx, ctx, {templateId, now}); if (active)
  await enqueueRecurringGenerate(tx, ctx, {templateId, period, runAt}) })` — self-perpetuate only
  while active (growth-cap, mirrors the dunning `enabled` gate).
- Enqueue the first `recurring_generate` on template creation.
- **`reapRecurring`** (`src/recurring/reap.ts`), registered via `registerReaper`: for every `active`
  template with `next_run_date <= today` and **no** live (`pending`/`running`) `recurring_generate`
  job, seed one — recovering never-seeded, terminal-`failed`, and re-activated chains. Idempotent via
  the `recurring:<templateId>:<period>` dedup key + `NOT EXISTS(live job)` guard. Runs on the
  supervisor tx; joins `recurring_invoice_templates` → `client_companies` for `firm_id`.

## 5. API + UI

- `web/app/api/recurring/route.ts` — GET (list) + POST (create; enqueues the first job).
- `web/app/api/recurring/[id]/route.ts` — PATCH (update, future-runs-only) + DELETE (deactivate).
- `assertRoleAllowed(ctx.actorRole, 'einvoice.issue')` on mutations.
- A management screen: list templates (customer, cadence, next run, active/ended), with
  create/edit/deactivate. i18n strings in all three catalogs (`web/app/lib/i18n.ts`).
- (Modified Next.js — read `web/node_modules/next/dist/docs/` before touching `web/`, per
  `web/AGENTS.md`.)

## 6. Testing (TDD, Vitest, serial `singleFork`)

Domain (`tests/recurring/`):
- Cadence math: `advanceRunDate` monthly/quarterly/annual; 31→short-month + Feb clamp via
  `clampToMonth`.
- Catch-up: a back-dated `next_run_date` generates exactly one invoice and advances past all missed
  periods (skip-to-current).
- End conditions: stops on `end_date` passed, on `occurrences_remaining` reaching 0, and on
  `active=false`.
- Autonomy: `auto` → `sendInvoice` path creates an `open` einvoice; `approval` → a
  `pending_approval` proposal of type `recurring_invoice`, and NO einvoice.
- Idempotency: re-running the same period is a no-op (dedup key + deterministic number).

Reaper (`tests/recurring/reap.test.ts` or fold into `tests/jobs/reaper.test.ts`): seeds for
never-seeded / terminal-failed / re-activated `active` templates due today; no-op when a live job
exists or the template is inactive; supervisor RLS cross-tenant read + negative-privilege check.

Handler / integration (`tests/jobs/`): a `drainOnce` cycle generates an `open` receivable that then
appears in `arAging`; inactive/ended template stops perpetuation (no successor job); active template
perpetuates exactly one successor.

Full suite must stay green (currently 386 + the reaper/supervisor/growth-cap tests added this
branch).

## Scope boundaries (YAGNI)

- No gapless legal invoice sequencing (deterministic number only; noted as a follow-up).
- No cron/weekly/interval-days cadence — anchor-day + month interval only.
- No backfill of missed periods (skip-to-current only).
- No approve→auto-issue automation beyond the existing proposals inbox (operator issues held
  invoices through the existing issue path).
- No template-level VAT/price versioning history — future edits apply to future runs; no audit of
  price-over-time beyond the standard `updated_at` + audit log.

## Self-review

- Placeholders: none — all fields, signatures, and file paths are concrete.
- Consistency: `generateDueRecurring` return `{generated, active}` used by the handler's perpetuation
  gate; dedup key `recurring:<templateId>:<period>` consistent across `enqueueRecurringGenerate`,
  handler, and reaper; autonomy op `recurring_invoice` consistent across the gate and the proposals
  CHECK extension.
- Scope: single implementation plan; mirrors the existing dunning + reaper structure closely.
- Ambiguity: catch-up explicitly skip-to-current (one invoice/call); numbering explicitly
  deterministic; approval path explicitly a proposal, not a draft einvoice state.

# AR dunning + late fees — design (M4 slice B)

Date: 2026-07-14. Status: approved for planning.

Slice B of the M4 "AR lifecycle" market gap (`docs/ROADMAP-market-gaps.md`). Builds on
slice A (`docs/superpowers/specs/2026-07-13-ar-money-in-loop-design.md`), which shipped the
open-item foundation: outbound `einvoices` carry `status`/`due_date`/`amount_paid_cents`, and
`arAging` buckets overdue receivables. Slice B adds **payment reminders (dunning)** and
**informational late fees** on top of that data.

## Problem

Once an invoice is overdue there is nothing that prompts anyone to chase it. Competitors ship
automated dunning (escalating reminders) and late-fee tracking. We have the overdue data
(slice A) but no reminder lifecycle, no per-invoice dunning state, and no late-fee calculation.

## Constraints that shaped scope

- **No email/SMS channel and no scheduler exist** in the codebase (grep-confirmed). Invoices
  leave via Peppol, not email. So slice B is **bookkeeper-facing** (surface "chase this" to the
  accountant, who acts), triggered **manually** via a route a scheduler could later call — not
  customer-facing auto-send.
- The GTM is accountant-led managing many clients (`PRODUCT.md`), so bookkeeper-facing prompts
  are the right primitive, not customer emails.

## Scope

In scope:
- Per-client **dunning policy**: escalating stages (level → days-overdue threshold) plus a
  late-fee rule; configurable, with built-in default stages when unconfigured.
- **`runDunning`**: scan overdue receivables, advance each to its reached level, emit one
  actionable **task** per newly-reached level (idempotent), recording a dunning event.
- **Informational late fees**: compute accrued late fee per the policy and surface it in the
  task message. No ledger posting.
- Manual trigger route + policy read/edit route + a policy editor UI.

Explicitly deferred (later slices / not this slice):
- A real scheduler (cron) to auto-run dunning — the route is cron-ready but wiring is out.
- Customer-facing reminder documents/emails (needs an email adapter — its own slice).
- Posting late fees to the ledger / as a chargeable receivable (VAT treatment of fees is its
  own accounting decision).
- Recurring invoices (C), quotes→invoice (D), customer statement view.

## Approach (the two forks)

- **Policy storage:** two relational tables (house convention over JSONB), not a JSONB column
  — validatable, editable, consistent with `src/`.
- **Prompt surface:** `createTask` (`src/collab/tasks.ts`) — a task has an open/resolved
  lifecycle and an existing UI (TaskList), fitting "chase this". `notify()` is fire-and-forget
  with no lifecycle, so it is not the primary surface (a notification could be added later).

## 1. Data — `migrations/033_dunning.sql`

Highest existing migration is `032`; this is `033`. All tables get full RLS mirroring
`032_receivables.sql` (`client_company_id` FK, `ENABLE/FORCE ROW LEVEL SECURITY`,
`_tenant_isolation` policy on `current_setting('app.current_client_id')`, grants to
`bookkeeping_app`).

- `dunning_policy(client_company_id uuid PK REFERENCES client_companies(id), enabled boolean
  NOT NULL DEFAULT true, late_fee_annual_bps int NOT NULL DEFAULT 0, late_fee_flat_cents bigint
  NOT NULL DEFAULT 0)` — one row per client; the fee rule + on/off switch. `annual_bps` = basis
  points per annum (e.g. 800 = 8%/yr); `flat_cents` = a flat fee applied per reached stage.
- `dunning_stages(id uuid PK, client_company_id uuid, level int NOT NULL, days_overdue int NOT
  NULL, UNIQUE(client_company_id, level))` — the escalation thresholds; variable count per
  client.
- `dunning_events(id uuid PK, client_company_id uuid, einvoice_id uuid REFERENCES einvoices(id),
  level int NOT NULL, accrued_fee_cents bigint NOT NULL, task_id uuid REFERENCES tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(client_company_id, einvoice_id, level))`
  — idempotency + history: a given invoice fires a prompt at most once per level.

(Confirm the actual PK/table names for `client_companies` and `tasks` against migrations at
implementation time and match them exactly.)

## 2. Domain — new `src/dunning/`

All functions `(tx: PoolClient, ctx: TenantContext, ...)`, Zod input schemas where there is
external input, `appendAudit` on mutations, money via integer cents (`src/db/money.ts`).

- **`policy.ts`**
  - `DEFAULT_STAGES: { level, daysOverdue }[]` = `[{1,1},{2,15},{3,30}]` (L1 first day overdue,
    L2 15 days, L3/Final 30 days).
  - `getDunningPolicy(tx, ctx) → { enabled, lateFeeAnnualBps, lateFeeFlatCents }` (returns the
    row or built-in defaults `{ enabled:true, 0, 0 }` when none).
  - `setDunningPolicy(tx, ctx, input)` — upsert (`ON CONFLICT (client_company_id) DO UPDATE`),
    mirror `autonomy_policy`; `appendAudit`.
  - `listStages(tx, ctx) → Stage[]` — the client's rows, or `DEFAULT_STAGES` when none.
  - `setStages(tx, ctx, stages[])` — replace the client's stage set (delete + insert in the
    tx); validate levels are distinct and ascending by `days_overdue`; `appendAudit`.
- **`late-fee.ts`** — pure, no DB:
  `accruedLateFeeCents({ outstandingCents, daysOverdue, annualBps, flatCents }): bigint`
  = `flatCents + round(outstandingCents * annualBps/10000 * daysOverdue/365)`. Integer-cents
  rounding (half-up). Zero when both rate and flat are zero.
- **`dunning.ts`**
  - `runDunning(tx, ctx, { asOf }) → { prompted: number, byLevel: Record<number, number> }`:
    1. If policy `enabled === false`, return zeros (no-op).
    2. Load stages (client rows or defaults) and the fee rule.
    3. Select open/partially_paid outbound `einvoices` with `due_date < asOf`.
    4. For each, `daysOverdue = asOf − due_date`; reached level = highest stage whose
       `days_overdue ≤ daysOverdue` (none → skip).
    5. If a `dunning_events` row already exists for `(einvoice, reached level)`, skip
       (idempotent). Otherwise: compute `accruedLateFeeCents`, `createTask` with a localized
       message (invoice number, days overdue, outstanding, accrued fee, level name), insert the
       `dunning_events` row referencing the task.
  - Uses `outstandingCents(row)` and the receivable read model from `src/receivables/`.

## 3. API routes + UI

- **`POST /api/receivables/dunning/run`** — body `{ clientCompanyId, asOf? }`; role-gated on
  `einvoice.issue` (reuse; no role-map migration). Returns the `runDunning` summary. Cron-ready.
- **`GET /api/receivables/dunning/policy`** / **`PUT`** — read/update policy + stages
  together. `getSessionToken → resolveTenantContext → assertRoleAllowed → withTenant →
  errorToStatus`, mirroring existing routes.
- **UI — dunning section on the `/reports` aged-receivables tab**
  (`web/app/(cabinet)/reports/page.tsx`): a policy editor (enabled toggle, annual-bps + flat-fee
  inputs, an editable stages table) and a "Run reminders" button showing the run summary. The
  prompts themselves appear in the existing tasks UI. All user-facing strings in **all three**
  i18n catalogs (`web/app/lib/i18n.ts`).

## 4. Testing

- `late-fee.ts` — pure unit tests: flat-only, annual-only, combined, zero rate, rounding
  boundary, zero days.
- `dunning.ts` — level selection at threshold boundaries; idempotency (re-run same `asOf`
  creates no duplicate task/event); skips paid/void and not-yet-due; respects `enabled=false`;
  default-stages fallback when unconfigured; escalation (a later run at a higher day-count fires
  the next level once).
- `policy.ts` — policy upsert round-trip; stage replace + ascending/distinct validation.
- API: `dunning/run` and `dunning/policy` via the handler-test pattern.
- Gate: root `npm test` green; `tsc --noEmit` clean in root **and** `web/`; `web` build clean.

## Conventions followed

`migration + domain (src/<module>/) + tests + API route + page`; RLS via `withTenant` never
bypassed; ledger untouched (late fees are informational this slice); integer cents; i18n in all
three catalogs; per-client config mirrors `autonomy_policy`; tasks via the existing
`src/collab/tasks.ts`. Symmetric with slice A's `src/receivables/` module layout.

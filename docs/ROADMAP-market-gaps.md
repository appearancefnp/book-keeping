# Roadmap — market-gap audit

Date: 2026-07-10. This roadmap audits the app against what **commercial bookkeeping
software ships as table stakes** — Xero, QuickBooks Online, Zoho Books, Sage, FreshBooks,
and the LV incumbents (Horizon / Jumis / 1C) — rather than against our own concept spec
(that is `docs/SPEC-AUDIT.md` + `HANDOFF.md`). It exists to catch gaps that *are not in our
spec at all* because we scoped around the AI/Peppol wedge and under-scoped the "boring core."

Grounded in a code check on this date, not just docs: the ledger exposes `trialBalance()` and
nothing else in the reporting family (`src/ledger/balances.ts`); there is no accounts-payable /
bill module; no multi-currency; no recurring / quote / credit-note / reminder logic; banking is
`camt.053` file-upload + matching only (`src/banking/`).

Legend: ✅ shipped · 🟡 backend only · 🔶 partial · ⛔ absent · 🔒 blocked on external decision.
Overlap with `HANDOFF.md` sections is noted as `[HANDOFF §n]`.

---

## Positioning

The hard, differentiating parts are strong and ahead of incumbents: append-only double-entry
ledger, AI/OCR intake, proposal/approval with inline rationale, RLS multi-tenancy, Peppol/
EN 16931, payroll engine. **The app is strong on the novel wedge and thin on the boring core.**
Tier 1 below is the credibility floor — the set that would lose a head-to-head demo against
Xero today. **As of 2026-07-29, all six Tier 1 rows are ✅ (M1, M2, M3, M5, M6, M7) — the
credibility floor is cleared: M1's Cash-Flow statement + Statement of Equity shipped 2026-07-29,
the last Tier-1 gap.** M4 is 🔶 but tracked separately from the credibility floor (its money-in
loop, dunning, and aging are shipped; only recurring invoices and quotes→invoice remain, both
Tier-2-adjacent polish rather than day-to-day bookkeeping table stakes). Tiers 2–4 are
prioritisation, not emergencies.

---

## Tier 1 — Table-stakes gaps NOT in our spec (the credibility floor)

These are absent everywhere (backend + UI) and, unlike the Phase 2–3 modules, are not
"advanced" — they are the definition of day-to-day bookkeeping.

| # | Gap | Status | Notes |
|---|-----|--------|-------|
| M1 | **Financial statements** — Profit & Loss / Income Statement, Balance Sheet, Cash-Flow statement, Statement of Equity, on demand for any period | ✅ | **P&L + Balance Sheet shipped 2026-07-10**; **Cash-Flow statement + Statement of Equity shipped 2026-07-29** — `src/reports/` (`profitAndLoss`, `balanceSheet`, `cashFlow`, `statementOfEquity` over `accountBalances`), read-only API routes, and the `/reports` page (period picker, trilingual, reconciliation/balanced-invariant indicators, CSV/Excel/PDF export). Cash-flow is indirect-method (net profit → working-capital → investing → financing → net change in cash), reconciling to the change in cash by construction; activity classification is a config account-code map defaulting to the LR chart, env-overridable (`CASHFLOW_CASH_CODES`/`CASHFLOW_INVESTING_CODES`/`CASHFLOW_FINANCING_CODES`), deliberately extending the hard-coded account-mapping debt (see M2 row / `HANDOFF.md`). No migration — statements key off `accounts.type` + the code map. Distinct from the statutory *annual report* (`HANDOFF §5`, §6.8). See `docs/superpowers/specs/2026-07-29-cash-flow-equity-design.md` and `docs/superpowers/plans/2026-07-10-financial-statements.md`. |
| M2 | **Accounts payable / vendor bills** — enter supplier bills, track what's owed, schedule/batch pay, AP aging | ✅ | **Shipped 2026-07-10** — `src/payables/` (bills, settlement, pay-run, aging), camt.053 debit matching (clear transit / settle direct), `/bills` + pay-run UI, aged-payables tab on `/reports` — the full money-out loop. M5 now has its AP half. |
| M3 | **Live bank feeds (open banking / PSD2)** | ✅ | **Shipped 2026-07-19** — `src/bankfeed/` (GoCardless Bank Account Data behind a `BankFeedProvider` seam mirroring `AccessPoint`/`VidClient`, plus a keyless auto-linking stub), connections/consent lifecycle UI on `/bank` + `/bank/callback`, daily Vercel cron (`web/vercel.json`) and manual "Sync now" feeding the existing camt.053 matching engine unchanged. Accepted limitations: cross-source dedup vs a camt.053 upload of the same account depends on the bank populating the end-to-end id in both sources; the hard-coded LR chart constants in `src/bankfeed/sync.ts` extend the pre-existing account-mapping debt (see M2 row / `HANDOFF.md`). See `docs/superpowers/specs/2026-07-19-bank-feeds-design.md`. |
| M4 | **AR lifecycle** — quotes/estimates → convert to invoice; **recurring / subscription invoices**; automated payment reminders (dunning); customer statements; late fees | 🔶 | **Slice A — AR money-in loop — shipped 2026-07-13** (`src/receivables/`: open-item tracking on `einvoices` + `invoice_payments`, `settleReceivable`, `arAging`, invoice-linked bank matching wired into camt.053 import via `proposeArMatches` + `receivable_direct` confirm branch, retiring the unused GL-level `proposeMatches`; aged-receivables tab on `/reports`; customer default payment terms). See `docs/superpowers/plans/2026-07-13-ar-money-in-loop.md`. **Slice A UI — shipped 2026-07-14** (`/invoices` payment-status/due/outstanding columns via extended `listEinvoices` + `PaymentStatusBadge`; inline settle/void drawer wired to `POST /api/receivables/[id]`; see `docs/superpowers/plans/2026-07-14-ar-ui-settle.md`). **Slice B — dunning + informational late fees — shipped 2026-07-14** (`src/dunning/`: per-client `dunning_policy`/`dunning_stages` config, pure `accruedLateFeeCents`, `runDunning` scanning overdue receivables and emitting idempotent per-level tasks via `dunning_events`; run + policy routes; policy editor + "Run reminders now" on the `/reports` AR-aging tab. Bookkeeper-facing — reminders surface as tasks. See `docs/superpowers/plans/2026-07-14-ar-dunning.md`. Pre-scheduler follow-ups tracked: `ON CONFLICT` on the events insert + route range-validation before wiring a cron). **Merged to `main` 2026-07-20**, together with the job-queue/worker/reaper infra the M4 workstream built as "C-infra" (durable Postgres `jobs` table + `bookkeeping_worker`/`bookkeeping_supervisor` roles + handler registry + `drainOnce` + chain reaper, `src/jobs/`) — this resolves slice C's scheduler gating decision (see the slice-C handoff doc: recurring generation becomes a `recurring_generate` job handler in `src/jobs/register.ts`, mirroring `dunning_run`'s self-perpetuation). Migrations renumbered 032→037 (receivables) and 033–036→038–041 (dunning, jobs, dunning-jobs-backfill, supervisor role) to land after the pre-existing `main` migrations; new **042** applies referenced AR credit notes against their invoice (`invoice_payments` method `'credit_note'`, capped at outstanding) so dunning stops chasing credited invoices, and nets unapplied credit-note remainders into `arAging` by issue-date age (GL-tied) — both integration reconciliations beyond the original slice plans. `GET /api/cron/jobs-drain` is now the Vercel cron entrypoint for the queue (06:00, after bank-sync 05:00), with timing-safe cron-secret auth on both cron routes. **Still ⛔: recurring/subscription invoices (C-recurring — scheduler now resolved, feature itself not started), quotes→invoice (D), customer statement view.** |
| M5 | **Aged receivables / payables reports** | ✅ | Both halves shipped: AP with M2 2026-07-10 (`src/payables/aging`, aged-payables tab), **AR with M4-A 2026-07-13** (`src/receivables/aging` `arAging`, aged-receivables tab on `/reports`), merged to `main` 2026-07-20. **AR-aging export parity shipped 2026-07-20** — CSV/Excel/PDF via the existing `GET /api/reports/export` + tabular model, matching the other six report tabs. |
| M6 | **Expense claims / reimbursements** — employee expenses, mileage, receipt → claim → approve → reimburse | ✅ | **Shipped 2026-07-20** — `src/expenses/` (claims CRUD with server-side totals, mileage km×rate with a rate snapshot on the line, self-scope so an employee/owner can only write their own claim while the firm side reads all), submit (draft→submitted with a posting proposal), approve (posts DR each line's expense account — net if VAT-deductible, gross if not, since non-deductible VAT is just part of the expense — DR 5722 for the summed deductible VAT, CR 5610 employee-settlement for the gross total; reject returns the claim to draft), reimburse (`settleClaim`: DR 5610 / CR bank, plus a pain.001 SEPA credit-transfer payment order keyed to the employee's IBAN), and receipt upload (blob + AI prefill, no intake-proposal side effect). Self-service rides `employees.user_id` (+ partial unique index) and a new `employees.iban`; `documents.source` gains `'expense'` for receipt photos that bypass the intake pipeline. Bank-side: `proposeExpenseMatches` recognizes bank debits equal to an approved claim's gross as `expense_direct` matches, wired into `/api/bank/import` and the bankfeed sync alongside the AP/AR matchers. New authz ops `expenses.write` (all four roles, self-scoped), `expenses.reimburse` + `expenses.settings.write` (firm-side only). Migration **045** (`expense_claims`, `expense_claim_lines`, `expense_settings`, RLS on all three). UI: `/expenses` — employee composer (receipt + mileage lines), firm reimburse view, owner read-only attributed list — plus a nav entry and employee-card user-link/IBAN fields. Account code **5610** (employee settlements) extends the existing hard-coded account-mapping debt (see M2 row / `HANDOFF.md`) — env-var overridable (`EXPENSE_SETTLEMENT_ACCOUNT`, `EXPENSE_VAT_INPUT_ACCOUNT`) but not yet a per-client settings screen. Full suite 609 tests. Deferred, documented as such: payroll-component payout (reimbursement via payslip rather than a standalone bank transfer), multi-currency claims, per-diem/business-trip daily allowances, and approval spending limits. |
| M7 | **Credit notes** | ✅ | **Shipped 2026-07-17** — both sides. AR: `sendCreditNote` (`src/einvoice/outbound.ts`) reverses receivable + output VAT, UBL `CreditNote` build/parse (`src/einvoice/ubl.ts`), `doc_type` on `einvoices`, `/api/credit-notes` + a "Credit note" mode in the `/invoices/new` composer with optional invoice reference (EN 16931 `BillingReference`) + outbox doc-type column. AP: `src/payables/credit-notes.ts` (`vendor_credit_notes` tables) reverses payables + input VAT through the approval queue, inbound Peppol `CreditNote` routing (`src/einvoice/inbound.ts`), `/api/vendor-credit-notes` + entry UI. `apAging` nets applied credit notes by age; **`computeVat` fixed to net both directions per VAT account** (credit notes reduce the return — the spec's "no change needed" assumption was wrong). See `docs/superpowers/specs/2026-07-17-credit-notes-design.md`. |

---

## Tier 2 — Known modules, ranked by competitive pain

Already in our spec / `HANDOFF §5`; ordering reflects how visibly each hurts against the market.

| # | Gap | Status | Notes |
|---|-----|--------|-------|
| M8 | **Multi-currency + FX revaluation** | ⛔ | `HANDOFF §5` (§6.1). Any client with one EU/USD invoice hits this wall. |
| M9 | **VAT completeness** — reverse charge, intra-EU, **EC Sales List + Intrastat** (legally required for EU cross-border), OSS for digital services, exemptions, cash-accounting scheme, monthly-vs-quarterly logic | 🔶 | **Slice A+B shipped 2026-07-31.** Shipped: the EN 16931 VAT category model (`S`/`Z`/`E`/`AE`/`K`/`G`/`O`, BT-151) on `einvoice_lines`/`bill_lines`/`vendor_credit_note_lines`, plus a fix so the category actually rides the wire UBL document correctly; reverse-charge self-assessment on bills and vendor credit notes (`selfAssessedVatCents`, posted both sides — VAT-input and VAT-output — by `buildBillEntry`/`buildCreditNoteEntry`); a category-aware VAT return (`src/tax/vat-breakdown.ts`, `VatDeclaration.breakdown`) with a ledger-vs-documents **reconciliation flag** (`reconciles`) that surfaces a manual journal entry hitting a VAT account with no document behind it; the **EC Sales List / PVN 2** (`src/tax/ecsl.ts` — goods/services split derived from the category, an issues list for unreportable rows, representative XML); filing **periodicity** (`src/tax/vat-settings.ts`, `src/tax/filing-periods.ts`, monthly/quarterly, due-date-to-next-working-day); and the **`/filings` page** (VAT-return + ECSL tabs, period picker, CSV/Excel/PDF export via the existing report machinery). **Still 🔶, not ✅ — out of scope and undone: Intrastat, OSS for digital services, the cash-accounting scheme, and VIES validation of VAT numbers** (format-checked only). No filing-submission path either — approval is the terminus (see `HANDOFF.md` known debt). Design: `docs/superpowers/specs/2026-07-29-vat-completeness-design.md`. Plans: `docs/superpowers/plans/2026-07-29-vat-categories.md` (categories + self-assessment) and `docs/superpowers/plans/2026-07-29-ec-sales-list.md` (breakdown/reconciliation + ECSL + `/filings`). |
| M10 | **Online payment collection** — "Pay now" links on invoices (Stripe / GoCardless) | ⛔ | Drives the get-paid-faster pitch Xero/FreshBooks lead with. Not in spec. |
| M11 | **Fixed assets & depreciation** | ⛔ | `HANDOFF §5` (§6.5). |
| M12 | **Inventory / warehouse** | ⛔ | `HANDOFF §5` (§6.4). |
| M13 | **UIN / MUN alternative tax regimes** | ⛔ | `HANDOFF §5` (§6.2). VAT is the only tax engine today; LV micro-enterprise clients can't be served. |

---

## Tier 3 — Reporting, tracking & analytics (thin across the board)

| # | Gap | Status | Notes |
|---|-----|--------|-------|
| M14 | **Report depth** — General Ledger detail, account-transactions drill, period-over-period comparatives, PDF/Excel/CSV export of any report | ✅ | **Data depth shipped 2026-07-18** — General Ledger detail (`src/reports/general-ledger.ts`: opening/running/closing per account), account drill-down (single-account GL + clickable P&L/Balance-Sheet/trial-balance line codes), and two-period comparatives with variance + % (`src/reports/comparative.ts`); new `/api/reports/general-ledger` + `/api/reports/trial-balance` routes, compare params on the P&L/BS routes, and General Ledger + Trial Balance tabs on `/reports`. All read-only over the existing ledger, no migration. **Export shipped 2026-07-18** — CSV (`src/reports/csv.ts`), Excel/.xlsx (ExcelJS, `web/app/lib/report-xlsx.ts`), and printable-HTML PDF (`src/reports/report-html.ts`) for all five reports, over a format-neutral `src/reports/tabular.ts` model, via `GET /api/reports/export` + per-tab CSV/Excel/PDF buttons on `/reports`. **M14 complete.** See `docs/superpowers/specs/2026-07-18-report-depth-design.md` and `docs/superpowers/specs/2026-07-18-report-export-design.md`. |
| M15 | **Dimensional tracking** — projects / cost centers / departments / "tracking categories" | ⛔ | Used constantly for job costing and management reporting. Needs a dimension column on journal lines + rollups. |
| M16 | **Budgeting & budget-vs-actual** | ⛔ | Standard in Xero/QB. |
| M17 | **Cash-flow forecast / anomaly detection / proactive reminders** | ⛔ | `HANDOFF §5` (§6.9). New tools/jobs on the existing `src/assistant/` agent — and competitively visible as a headline feature. |

---

## Tier 4 — Onboarding, ecosystem & firm-level (the accountant-led moat)

Weighted higher for us than for a self-serve SMB tool, because the GTM is accountant-led
managing many clients (`PRODUCT.md`).

| # | Gap | Status | Notes |
|---|-----|--------|-------|
| M18 | **Historical data import / migration** — opening balances + prior-year data, import from Xero/QB/CSV | ⛔ | *The* friction point when winning a client off an incumbent. Not in spec anywhere. |
| M19 | **Practice-management layer** — cross-client compliance calendar, deadline/workload dashboard, staff time/WIP, client billing | 🔶 | We have multi-client cabinet + tasks + tariffs, but `/admin` is CRUD only. Xero Practice Manager / QBO Accountant own this space. |
| M20 | **Email-in document capture** — dedicated inbox to forward bills/receipts (Dext/Hubdoc pattern) | ⛔ | Camera capture only today. |
| M21 | **Formal bank reconciliation** — reconcile-to-statement-balance with a signed-off reconciliation report | 🔶 | We match transactions to a `reconciled` status but there's no monthly statement-balance reconciliation flow accountants sign off. |
| M22 | **Open API + integrations marketplace** | ⛔ | `HANDOFF §5` (§9). Blocks e-commerce/POS/Stripe connectors competitors treat as baseline. |

---

## Cross-cutting (already tracked in HANDOFF, listed for completeness)

GDPR export/erasure ⛔ · e-signature ⛔ · native mobile + offline queue 🔶 · push dispatch
(no APNs/FCM) 🔶 · 2FA enrolment UX ⛔ · login rate-limiting + audit hash-chain ⛔ ·
server-side role gating on mutating routes (G1) · owner-calm view (G3). See `HANDOFF.md`
cross-cutting section.

---

## Suggested sequencing

The three that decide a head-to-head demo, do first, in order:

1. **M1 — Financial statements.** New `src/reports/` (P&L, Balance Sheet, Cash Flow) over the
   existing ledger; no migration to start. Unlocks M5 and M14 cheaply.
2. **M2 — Accounts payable / bills.** Completes the money-out half of bookkeeping; reuses
   parties + proposals + the `pain.001` composer.
3. **M3 — Live bank feeds.** ✅ Shipped 2026-07-19 — feed adapter (GoCardless Bank Account Data)
   behind the established interface+stub seam; existing matching engine consumes it unchanged.

M7 (credit notes) is done (✅, shipped 2026-07-17); M6 (expense claims) is done (✅, shipped
2026-07-20); M1 (financial statements) is now done (✅ — Cash-Flow + Statement of Equity shipped
2026-07-29, completing the set). M4 (AR lifecycle, 🔶) rounds out invoicing — C-recurring and
slice D (quotes→invoice, customer statements) remain. M9 (VAT completeness) is no longer
unstarted either — slice A+B shipped 2026-07-31 (VAT categories, reverse-charge
self-assessment, the category-aware VAT return with its reconciliation flag, the EC Sales
List, filing periodicity, and `/filings`), leaving it 🔶 with Intrastat, OSS for digital
services, the cash-accounting scheme, and VIES validation as the remaining scope. **With all
six Tier-1 rows shipped, the credibility floor is cleared;** the next unblocked work is M4's
remaining slices, then M9's remaining scope alongside M8/M10–M13 in the spec's Phase 2–3 order
(Tiers 3–4 opportunistic). Every item follows
the house convention:
**migration + domain (`src/<module>/`) + tests + API route + page**, external systems behind an
adapter interface with a stub (`HANDOFF.md` Conventions).

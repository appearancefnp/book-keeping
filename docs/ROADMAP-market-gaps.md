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
Xero today. Tiers 2–4 are prioritisation, not emergencies.

---

## Tier 1 — Table-stakes gaps NOT in our spec (the credibility floor)

These are absent everywhere (backend + UI) and, unlike the Phase 2–3 modules, are not
"advanced" — they are the definition of day-to-day bookkeeping.

| # | Gap | Status | Notes |
|---|-----|--------|-------|
| M1 | **Financial statements** — Profit & Loss / Income Statement, Balance Sheet, Cash-Flow statement, Statement of Equity, on demand for any period | 🔶 | **P&L + Balance Sheet shipped 2026-07-10** — `src/reports/` (`profitAndLoss`, `balanceSheet` over `accountBalances`), read-only API routes, and the `/reports` page (period picker, trilingual, balanced-invariant indicator). Balance Sheet folds the unclosed current-period result into equity. **Cash-Flow statement + Statement of Equity still ⛔** (Cash-Flow needs activity classification — its own design). Distinct from the statutory *annual report* (`HANDOFF §5`, §6.8). Unblocks M5 (aged reports) and M14 (report depth). See `docs/superpowers/plans/2026-07-10-financial-statements.md`. |
| M2 | **Accounts payable / vendor bills** — enter supplier bills, track what's owed, schedule/batch pay, AP aging | ✅ | **Shipped 2026-07-10** — `src/payables/` (bills, settlement, pay-run, aging), camt.053 debit matching (clear transit / settle direct), `/bills` + pay-run UI, aged-payables tab on `/reports` — the full money-out loop. M5 now has its AP half. |
| M3 | **Live bank feeds (open banking / PSD2)** | 🔶 | `camt.053` file upload only — reads as "legacy" against every cloud competitor. Wire a feed provider (e.g. GoCardless Bank Account Data / Nordigen, Salt Edge) behind a new adapter mirroring the `AccessPoint`/`VidClient` seam; the existing matching engine consumes it unchanged. |
| M4 | **AR lifecycle** — quotes/estimates → convert to invoice; **recurring / subscription invoices**; automated payment reminders (dunning); customer statements; late fees | ⛔ | The invoice composer issues one-off invoices only. Recurring invoices + reminders are headline features in Xero/QB/FreshBooks. Builds on the existing `einvoice` + parties + notifications/task substrate. |
| M5 | **Aged receivables / payables reports** | 🔶 | AP half shipped with M2 2026-07-10 (`src/payables/aging`, aged-payables tab on `/reports`). AR aging still ⛔ — `/overview` shows a receivables total but no aging buckets. |
| M6 | **Expense claims / reimbursements** — employee expenses, mileage, receipt → claim → approve → reimburse | ⛔ | OCR intake exists but there is no claim workflow. Ties into payroll (reimbursement via pay) and the approval queue. |
| M7 | **Credit notes** | ✅ | **Shipped 2026-07-17** — both sides. AR: `sendCreditNote` (`src/einvoice/outbound.ts`) reverses receivable + output VAT, UBL `CreditNote` build/parse (`src/einvoice/ubl.ts`), `doc_type` on `einvoices`, `/api/credit-notes` + a "Credit note" mode in the `/invoices/new` composer with optional invoice reference (EN 16931 `BillingReference`) + outbox doc-type column. AP: `src/payables/credit-notes.ts` (`vendor_credit_notes` tables) reverses payables + input VAT through the approval queue, inbound Peppol `CreditNote` routing (`src/einvoice/inbound.ts`), `/api/vendor-credit-notes` + entry UI. `apAging` nets applied credit notes by age; **`computeVat` fixed to net both directions per VAT account** (credit notes reduce the return — the spec's "no change needed" assumption was wrong). See `docs/superpowers/specs/2026-07-17-credit-notes-design.md`. |

---

## Tier 2 — Known modules, ranked by competitive pain

Already in our spec / `HANDOFF §5`; ordering reflects how visibly each hurts against the market.

| # | Gap | Status | Notes |
|---|-----|--------|-------|
| M8 | **Multi-currency + FX revaluation** | ⛔ | `HANDOFF §5` (§6.1). Any client with one EU/USD invoice hits this wall. |
| M9 | **VAT completeness** — reverse charge, intra-EU, **EC Sales List + Intrastat** (legally required for EU cross-border), OSS for digital services, exemptions, cash-accounting scheme, monthly-vs-quarterly logic | 🔶 | Partly noted in `HANDOFF §5`. EC Sales List / Intrastat as *filings* are compliance-mandatory, not nice-to-have, and are not named in the spec. Extend `src/tax/`. |
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
3. **M3 — Live bank feeds.** Feed adapter behind the established interface+stub seam; existing
   matching engine consumes it unchanged.

Then M4 (AR lifecycle) and M7 (credit notes) round out invoicing; M8–M13 follow the spec's
Phase 2–3 order; Tiers 3–4 are opportunistic. Every item follows the house convention:
**migration + domain (`src/<module>/`) + tests + API route + page**, external systems behind an
adapter interface with a stub (`HANDOFF.md` Conventions).

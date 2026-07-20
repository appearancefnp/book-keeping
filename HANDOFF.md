# Handoff — next steps

Status as of 2026-07-03. Written after a full audit of the repo against
`Gramatvedibas_sistemas_koncepcija.docx` (the concept spec) plus four UI passes
(harden → adapt → clarify → polish).

## Where things stand

The **MVP presentation layer and its tested backend are done**: ledger, VAT
compute + declaration, bank import (camt.053) + AI matching, AI document intake
(real Claude/Gemini/Ollama extraction), the proposal/approval workflow with
inline rationale, the shared cabinet (roles, tasks, comments, notifications,
audit), 2FA, and RLS multi-tenancy. 146 backend tests pass. The web UI is
trilingual (LV/RU/EN), responsive, and accessible.

> **See also `docs/ROADMAP-market-gaps.md`** (2026-07-10) — audits the app against
> commercial bookkeeping software (Xero/QuickBooks/Zoho/Sage/FreshBooks, LV Horizon/Jumis)
> rather than our own spec. Surfaces table-stakes gaps we scoped around: financial statements
> (P&L/BS/cash-flow), accounts payable/bills, live bank feeds, AR lifecycle (recurring
> invoices/quotes/reminders), aged AR/AP, expense claims.
>
> **Progress:** M6 (expense claims) — **done, shipped 2026-07-20**, see entry below.
> M1 (financial statements) — **P&L + Balance Sheet shipped 2026-07-10**
> (`src/reports/`, `/reports` page; Cash-Flow still deferred, needs activity classification).
> M2 (accounts payable) — **done, shipped 2026-07-10** — `src/payables/` (bills, settlement,
> pay-run, aging), camt.053 debit matching (clear transit / settle direct), `/bills` + pay-run UI,
> aged-payables tab on `/reports` — the full money-out loop. M5 now has its AP half.
> M7 (credit notes) — **done, shipped 2026-07-17** — both sides: AR `sendCreditNote`
> (reverses receivable + output VAT, UBL `CreditNote`, `doc_type` on `einvoices`,
> `/api/credit-notes` + composer "Credit note" mode + outbox column) and AP vendor credit
> notes (`src/payables/credit-notes.ts` + `vendor_credit_notes` tables, reverses payables +
> input VAT via the approval queue, inbound Peppol `CreditNote` routing, `/api/vendor-credit-notes`
> + entry UI). `apAging` nets applied credit notes; **`computeVat` was fixed to net both
> directions per VAT account** so credit notes reduce the return (the M7 spec's "no change
> needed" assumption was wrong — no settlement postings hit the VAT accounts, so single-sided
> historical data is unaffected). This lifts the M2 negative-bill rejection cleanly (bills stay
> non-negative; credit notes are their own path) — no longer an open follow-up. Full suite 351/351.
> M14 (report depth) — **data depth shipped 2026-07-18** — General Ledger detail
> (`src/reports/general-ledger.ts`), account drill-down (single-account GL + clickable
> statement/trial-balance line codes), two-period comparatives with variance + %
> (`src/reports/comparative.ts`); new `/api/reports/general-ledger` + `/api/reports/trial-balance`,
> compare params on the P&L/BS routes, and General Ledger + Trial Balance tabs on `/reports`.
> Read-only over the ledger, no migration. **Report export shipped 2026-07-18** — CSV
> (`src/reports/csv.ts`), Excel/.xlsx (ExcelJS, `web/app/lib/report-xlsx.ts`), and
> printable-HTML PDF (`src/reports/report-html.ts`) for all five reports, over a neutral
> `src/reports/tabular.ts` model, via `GET /api/reports/export` + per-tab export buttons.
> **M14 is now complete.** ExcelJS is the one new (web-only) dependency.
> M3 (live bank feeds) — **shipped 2026-07-19** — `src/bankfeed/` (GoCardless Bank Account Data
> behind the `BankFeedProvider` seam, mirroring `AccessPoint`/`VidClient`, plus a keyless
> auto-linking stub for dev/demo), connections/consent lifecycle UI on `/bank` (`/bank/callback`
> finalize), and a daily Vercel cron (`web/vercel.json`, `GET /api/cron/bank-sync`) plus manual
> "Sync now" that both feed the existing camt.053 matching pipeline unchanged. Two accepted
> limitations, both documented in `docs/superpowers/specs/2026-07-19-bank-feeds-design.md`:
> cross-source dedup against a camt.053 upload of the same account only holds when the bank
> populates the end-to-end id in both sources (normal for SEPA, but not guaranteed); and the
> hard-coded LR chart account constants in `src/bankfeed/sync.ts` (`2310`/`5310`/`2620`/`2699`)
> extend the existing "account-mapping is hard-coded" debt (§M2 follow-ups below) rather than
> resolving it — still needs the same per-client account-mapping settings screen.
> Next unblocked in the market-gaps sequence: M4 (AR lifecycle) merged 2026-07-20 (see entry
> below); report export (M14 follow-on). M14 data-depth is done.
> **Pre-cutover follow-ups (final branch review, 2026-07-19):**
> 1. Run `scripts/bankfeed-sandbox.ts` against the live GoCardless sandbox before enabling
>    real keys (acceptance was keyless/stub).
> 2. A 429 on the account-details call fails the whole sync at connection level (now
>    mitigated by per-requisition caching; residual on first sync).
> 3. Cosmetics that ride: no confirmation on connection Remove, misleading success toast when
>    a manual sync finds the consent expired, raw provider error text untranslated in
>    `last_error`.
> 4. With GoCardless keys unset in production the stub will "connect" a demo bank and import
>    demo transactions into real books — the real-key cutover must remove stub-imported rows
>    via the normal reversal flow.
>
> **M4 (AR lifecycle) + M5 (aged AR/AP) — merged to `main` 2026-07-20.** Slices A (AR
> money-in loop, shipped 2026-07-13), A-UI (settle/void drawer + payment columns, shipped
> 2026-07-14), and B (dunning + informational late fees, shipped 2026-07-14) landed together
> with the job-queue infra the M4 workstream built as "C-infra": a durable Postgres `jobs`
> table + `bookkeeping_worker`/`bookkeeping_supervisor` login roles + handler registry +
> `drainOnce` + a chain reaper (`src/jobs/`), first consumed by `dunning_run`'s
> self-perpetuating daily chain. Migrations renumbered on merge: receivables 032→**037**,
> dunning **038**, jobs **039**, dunning-jobs-backfill **040**, supervisor-role **041**; new
> **042** (`migrations/042_credit_note_applications.sql`) is an integration reconciliation, not
> in the original slice plans. Reconciliations done during integration, beyond what the slice
> plans scoped:
> - Referenced AR credit notes now **apply against their invoice**
>   (`src/receivables/apply-credit-note.ts`: `invoice_payments` row, method `'credit_note'`,
>   capped at outstanding) so dunning stops chasing credited invoices.
> - Unapplied credit-note remainders **net into `arAging`** by issue-date age
>   (`src/receivables/aging.ts`), keeping the report GL-tied.
> - `main`'s bankfeed sync now calls the branch's invoice-linked AR matcher
>   `proposeArMatches`; the GL-level `proposeMatches` is retired.
> - Firm-side authz operations `receivables.settle` / `dunning.write` / `dunning.run`
>   (`src/authz/policy.ts`) — settlement and dunning are accountant/firm_admin actions, not
>   client-facing.
> - `GET /api/cron/jobs-drain` is a new Vercel cron (06:00 daily, after bank-sync 05:00,
>   `web/vercel.json`) draining the job queue in production; cron-secret comparison is now
>   **timing-safe on both cron routes** (closes pre-cutover item 3's first cosmetic above).
> - AR-aging export parity — CSV/Excel/PDF for the `/reports` AR-aging tab, matching the
>   other six report tabs (`src/reports/tabular.ts` + `GET /api/reports/export`).
> Full suite: **559 tests**. Still open: **C-recurring** (recurring/subscription invoices —
> the job-queue scheduler gate is now resolved; see
> `docs/superpowers/handoffs/2026-07-14-c-infra-shipped-next-c-recurring.md` and
> `docs/superpowers/handoffs/2026-07-14-slice-c-recurring-invoices.md`), **slice D**
> (quotes→invoice, customer statements), and the per-client account-mapping settings screen
> debt (unchanged, see §M2 follow-ups above). Known follow-up (final-review, 2026-07-20):
> `/api/cron/jobs-drain` drains at most 20 jobs per daily tick (`drainOnce` called once,
> `limit: 20`) — fine at hobby scale, but loop reap+drain under a time budget before
> C-recurring adds a second daily job type to the queue; the standalone `npm run worker` is
> unaffected.
>
> **M6 (expense claims / reimbursements) — done, shipped 2026-07-20.** `src/expenses/`:
> claims CRUD with server-side totals, mileage lines (km × rate, with the rate snapshotted
> onto the line at entry time so a later mileage-rate change doesn't retroactively reprice
> old claims), and self-scope (employee/owner can create/edit/submit/delete only their own
> claim; firm roles read and act on all). Lifecycle: submit (draft→submitted, creates a
> pending posting proposal); approve posts DR each line's expense account (net if the line
> is VAT-deductible, gross if not — non-deductible VAT is just part of the expense cost) +
> DR **5722** for the summed deductible VAT, CR **5610** (new "employee settlements" account)
> for the claim's gross total; reject sends the claim back to `draft` (mirrors the bill/AR
> reject pattern). Reimburse: `settleClaim` (DR 5610 / CR bank) plus a pain.001 SEPA
> credit-transfer payment order built per-claim to the employee's IBAN (throws, naming
> whoever's missing one, if any payee lacks it). Receipt upload goes through the blob store
> with AI prefill but deliberately skips the intake-proposal pipeline (a receipt is a claim
> line, not a document awaiting a posting decision). Self-service rides two new employee
> columns — `user_id` (+ a partial unique index enforcing at most one link per user per
> client) and `iban` — and `documents.source` gains `'expense'` for these receipt photos.
> Bank side: `proposeExpenseMatches` recognizes a bank debit equal to an approved claim's
> gross as an `expense_direct` match, wired into `/api/bank/import` and the bankfeed sync
> next to the existing AP/AR matchers; `confirmMatch` settles it through `settleClaim`.
> New authz ops: `expenses.write` (all four roles, self-scoped), `expenses.reimburse` +
> `expenses.settings.write` (firm-side only — reimbursing and setting the mileage rate are
> accountant/firm_admin actions). Migration **045**: `expense_claims` / `expense_claim_lines`
> / `expense_settings` (RLS + FORCE RLS + tenant-isolation policy on all three, mirroring the
> rest of the schema), `expense_settings` holding one row per client with a default
> 30-cents/km mileage rate. Routes: `/api/expenses` (GET/POST), `/api/expenses/[id]`
> (submit|settle|delete), `/api/expenses/payment-order`, `/api/expenses/settings` (GET/PUT),
> `/api/expenses/upload`. UI: `/expenses` — employee composer (receipt + mileage lines),
> firm reimburse view, owner read-only attributed list — nav entry, and employee-card
> user-link + IBAN fields (`/payroll/employees/[id]`). Full suite: **609 tests**. Account
> **5610** extends the pre-existing hard-coded account-mapping debt (§M2 follow-ups above) —
> settlement/VAT-input accounts are env-var overridable (`EXPENSE_SETTLEMENT_ACCOUNT`,
> `EXPENSE_VAT_INPUT_ACCOUNT`) same as the bills/pay-run routes, but there is still no
> per-client account-mapping settings screen. Deferred, documented as such rather than
> silently dropped: reimbursement via a payroll component (payout through the next payslip
> instead of a standalone bank transfer), multi-currency claims, per-diem/business-trip
> daily-allowance orders, and approval spending limits.
> M6 known debt, also documented rather than silently dropped:
> - Owner segregation-of-duties: the owner role is in `proposals.decide`, so an owner can
>   submit *and* approve their own expense claim — but cannot self-pay, since
>   `expenses.reimburse` is firm-only. Revisit dropping owner from expense-claim approval
>   if an auditor objects.
> - `buildReimbursementOrder` records no "reimbursement initiated" state, so the same
>   pain.001 payment order can be generated twice; a double-pay is caught today by
>   `expense_direct` bank-match dedup (only one debit can settle a claim) — add an
>   order-generated marker once real bank sends land.
>
> **M2 branch status & follow-ups (2026-07-13):** shipped on branch `m2-accounts-payable`,
> since merged to `main`; full backend suite **333/333**, root+web typecheck clean, web
> build clean. Per-task reviews all passed; a **final whole-branch review (workflow, high
> effort) was run** and surfaced 10 findings — the **5 correctness bugs were fixed** on-branch
> and re-reviewed:
> - Inbound Peppol booking now **rejects** invoices whose declared totals don't reconcile
>   (net + VAT ≠ grand, or Σ line-nets ≠ declared net) instead of silently under-recording
>   the bill vs the vendor's PayableAmount.
> - Transit clearing now keys on the **pay-run total** (a SEPA batch is one lump bank debit),
>   with a post-time `cleared_at` guard + propose-time dedup, so account `2699` always nets to
>   zero and a payment/run can't be cleared twice.
> - AP direct-match now **dedupes** so two equal-amount debits can't both settle (and strand)
>   the same bill.
> - Bills with **negative net/VAT** (credit notes, out of scope → M7) are rejected with a
>   clear message instead of failing later as an unbalanced entry.
> Deferred follow-ups (documented, not blocking):
> - ~~**Pre-existing VAT-account bug (not M2, same family — fix soon):**~~ **FIXED 2026-07-13.**
>   `web/app/api/documents/capture/route.ts` now sets `vatInputAccount: '5722'` (Input VAT)
>   instead of `5721` (Output VAT), matching `/api/bills`; captured purchase VAT no longer
>   corrupts the VAT return. Misleading `5721` stand-in in `tests/intake/map-posting.test.ts`
>   was also corrected to `5722`.
> - ~~**Bank-match reject doesn't free the transaction**~~ **FIXED 2026-07-18** (branch
>   `fix/known-issues`): `rejectProposal` now reverts the linked transaction to `unmatched`
>   (guarded so a `reconciled` transaction is never regressed) for all three `bank_match`
>   payload variants; covered by `tests/banking/reject-frees-transaction.test.ts`.
> - **Account-mapping is hard-coded** (`5310/5722/2620/2699` defaults in the bills + pay-run
>   + ap-aging routes) — accountant to confirm LR chart codes; a per-client account-mapping
>   settings screen is still deferred (same bucket as tariffs/templates).
> - AP bank-matching is amount-only with a narrow propose-time TOCTOU window (guarded at post
>   time) — revisit with reference/fuzzy matching + a hard reservation.
> - Minor cleanups logged in `.superpowers/sdd/progress.md` (M2 section): tighten `vatRate`
>   bound, dedupe `billIds` in pay runs, type `BillRow.status` as a union, broaden the aging
>   bucket-boundary test, add the Σ-line-nets reconciliation-branch test, centralize
>   `isValidIsoDate`, unify report-tab money formatting, share `fmtDate`/`statusLabel`,
>   header-only `getBill` in settle/pay-run, load parties once in `resolveOrCreateVendor`.

What remains is **not polish** — it's substantive feature work in two buckets:

1. **Wire the two stubbed integrations to real networks** (Peppol, VID/EDS).
   These are the product's strategic reason to exist and are the critical path.
2. **Build the missing UI over the existing tested API**, then the absent
   accounting modules (payroll, fixed assets, warehouse, annual report).

The architecture was shaped so these plug in rather than require rework: the
Access Point, VID client, and extractor are all interfaces with stub
implementations; the domain layer is imported into Next.js routes via
`@domain/*`. Follow the existing patterns — don't invent new ones.

Priority order below is deliberate: it front-loads the regulatory critical path
(#1, #2) and the invoicing UI (#3) that unlocks the client-employee role, then
the operational modules.

---

## 1. Peppol Access Point — real network connectivity  ⟶ critical path

**Why first:** the entire market wedge (spec §2.1) is native Peppol + near-real-
time VID. Everything else is table stakes; this is the differentiator, and the
2028 B2B mandate is the clock.

**What exists (all real except the wire):**
- `src/einvoice/ubl.ts` — `buildUblInvoice` / `parseUblInvoice`, EN 16931 /
  Peppol BIS Billing 3.0, `EInvoice` type.
- `src/einvoice/validate.ts` — EN 16931 field/structure validation.
- `src/einvoice/inbound.ts` — receive → parse → create posting proposal.
- `src/einvoice/outbound.ts` — `sendInvoice(...)` builds UBL, posts the
  receivable, sends via the Access Point, records the Peppol message id.
- `src/einvoice/access-point.ts` — **the seam.** `interface AccessPoint {
  send(ublXml, recipient); receive(); }` with an in-memory `StubAccessPoint`.
- `migrations/015_einvoices.sql` — einvoice records with Peppol + VID status.

**What to build:**
- A real `AccessPoint` implementation against an accredited LV Peppol service
  provider (decision deferred in spec §10.3 — pick provider first: accredited
  SP vs. direct SMP/SML connection). Keep it behind the existing interface.
- Participant lookup (SML/SMP) to resolve a recipient's Peppol ID.
- Inbound polling or webhook ingestion → feed `inbound.ts`.
- Delivery/error state on `einvoices` (MDN/ack handling, retries).
- Config: endpoint URL, credentials/cert, sender Peppol ID — via env, injected
  the way `StubAccessPoint` is today (constructor/DI, not hard-coded).

**Acceptance:** send a real invoice to a Peppol test participant and receive one
back through the sandbox network, with status transitions recorded and audited.
Keep `StubAccessPoint` for tests.

**Open questions to resolve first:** provider choice; certificate/onboarding;
whether we register as our own AP or resell an SP's.

---

## 2. VID / EDS submission — real filing  ⟶ critical path

**Why:** spec §2.1/§6.8 — invoice data to VID within 5 working days, near real
time; declarations filed through EDS. Today it's tracked but nothing leaves the
building.

**What exists:**
- `src/einvoice/vid.ts` — **the seam.** `interface VidClient { submit(ublXml):
  Promise<{ ok; detail }> }`, `submitToVid(...)` records attempts + status,
  `addWorkingDays()` for the 5-day due date (skips weekends **and** LR public
  holidays — shared calendar `src/calendar/holidays.ts`, incl. the May 4 / Nov 18
  observed-Monday rule).
- `src/einvoice/outbound.ts` — overdue-VID detection.
- `migrations/016_vid_submission_attempts.sql` — attempt audit trail.
- `src/tax/vat-declaration.ts` — assembles the VAT declaration and exports XML
  (⚠️ **representative mock; exact VID element names not finalised** — see the
  Plan 6 note in that file).

**What to build:**
- A real `VidClient` against the VID/EDS API (auth, submission, status poll).
- Finalise the EDS declaration XML to the real schema (VAT return + annexes),
  replacing the mock. **Do this with a practising LV accountant/tax consultant**
  (spec §10.1) — the exact forms and norm references are not something to guess.
- A submission scheduler: enqueue within the 5-working-day window, retry on
  failure, surface overdue items to the accountant.
- ~~The 5-day due-date calc needs the **LR public-holiday calendar** (currently
  only weekends are skipped).~~ **FIXED 2026-07-19** — shared `src/calendar/holidays.ts` (observed-Monday rule included), also wired into payroll workdays.

**Acceptance:** file a VAT declaration and push invoice data to the VID test
environment; attempts recorded, overdue detection drives a notification/task.

---

## 3. Invoice creation UI + issue flow  ⟶ ✅ SHIPPED 2026-07-04 (except credit notes)

> Shipped in the MVP-UI pass (see `docs/superpowers/plans/2026-07-03-mvp-ui-over-tested-api.md`):
> invoice composer at `/invoices/new` (customer picker from parties, VAT auto-compute
> from `tax_rules`, live cent-safe totals), issue flow through `POST /api/einvoices`
> (→ `sendInvoice`, StubAccessPoint until #1 lands), outbox at `/invoices` with
> Peppol + VID status columns, and `GET /api/vat-rate`. **Still open: credit notes**
> (backend + UI — needs UBL CreditNote document type; scope as its own plan).

## 3-original. Invoice creation UI + issue flow  ⟶ unlocks the client-employee role

**Why:** the backend can build/validate/post/send outbound invoices, but there
is **no screen to create one**. The spec's client-employee role ("izraksta
rēķinus", §5) literally cannot do its job today. This is the highest-value UI gap.

**What exists:**
- `src/einvoice/outbound.ts` `sendInvoice(...)` — the whole issue pipeline.
- `src/einvoice/ubl.ts` `EInvoice` — the shape to collect: invoiceNumber,
  issueDate, currency, supplier, customer, lines (desc/net/vatRate/vat),
  net/vat/grand totals.
- `src/parties/parties.ts` — customer lookup for the recipient.
- `src/tax/rules.ts` — effective VAT rate for line defaults.

**What to build:**
- An **invoice composer** page/route: pick customer (from parties), add lines,
  auto-compute VAT from `tax/rules`, live totals (reuse the tabular-numeral
  table styling from `PostingLines`), then Issue.
- A new API route `web/app/api/einvoices/...` following the existing pattern
  (see any route in `web/app/api/` — session via `getSessionToken()`, tenant via
  `resolveTenantContext`, domain call inside `withTenant`). None exists yet;
  `einvoice` is not currently exposed over HTTP.
- An **outbox / invoice list** view with Peppol + VID status per invoice
  (depends on #1/#2 for live status; ship with status column now).
- Credit notes (backend gap too — no credit-note support yet).

**Acceptance:** an employee creates an invoice, it posts the receivable, renders
valid EN 16931 UBL, and (once #1 lands) sends via Peppol.

---

## 4. Remaining MVP-tier UI over existing tested API

These backends are done; the UI is missing. Follow the `web/app/(cabinet)/*`
page pattern and the `@domain/*` route pattern.

Shipped 2026-07-04 (MVP-UI pass):

- ✅ **Bank statement upload** — `/bank`: camt.053 upload (`POST /api/bank/import`),
  imported-transactions view (`GET /api/bank/transactions`, `listBankTransactions`);
  match proposals continue to flow through the approval queue.
- ✅ **Payment orders** — `/bank`: pain.001 composer + download
  (`POST /api/bank/payment-orders`, audited). Bank submission remains a separate
  integration decision.
- ✅ **VID/deadline view** — calm deadline strip on `/overview`
  (`upcomingVidDeadlines` in `src/einvoice/vid.ts`, `GET /api/vid/deadlines`).
- ✅ **Journal / entry browser** — `/journal` (`listJournalEntries` in
  `src/ledger/query.ts`, `GET /api/journal`).
- ✅ **Period management UI** — `/settings` (admin-gated; `listPeriods` +
  open/close via `GET/POST /api/periods`).
- ✅ **Party (customer/vendor) management UI** — `/parties`
  (`GET/POST /api/parties`, `PATCH /api/parties/:id`).
- ✅ **Autonomy-settings UI** — `/settings` (admin-gated; `listAutonomyPolicies` +
  `setAutonomy` via `GET/POST /api/autonomy`).

Still open in this bucket:
- **Admin is read-only** — spec §5 wants the admin to manage clients, tariffs,
  permissions, templates. Tariffs and templates don't exist anywhere (backend +
  UI); scope them.
- **Settings / 2FA enrolment** — TOTP secrets exist server-side but there's no
  user-facing setup/recovery, no profile/settings page.

---

## 5. Absent accounting modules (spec §6, Phase 2–3)

Net-new backend + UI. Each needs migrations, a `src/<module>/`, tests, API
routes, and pages. **Engage the accountant/tax consultant (spec §10.1)** for
LR-specific rules in every one.

- **Payroll & HR (§6.3)** — ✅ phase-1 calculation core shipped (see
  `docs/superpowers/plans/2026-07-09-payroll-phase1-core.md`): employee card,
  monthly tax-status data, orders (rīkojumi), deterministic bruto→neto engine
  (IIN/VSAOI 2026, versioned in `tax_rules`), shared average earnings, A-lapa
  sick pay, vacation accrual + postings, termination settlement, API routes.
  ✅ phase-2 operator UI shipped (see
  `docs/superpowers/plans/2026-07-09-payroll-phase2-operator-ui.md`): employees,
  orders, and the monthly run with an exceptions-first review, payslip
  explanation, and approve→post — plus manual adjustments with a mandatory
  reason (instr. 5). Still open: VID EDS payroll reports (instr. 3.5 —
  deliberately last), order PDF + eParaksts, employee self-service portal
  (instr. 2.3), AI helpers (7.x), scheduled auto-run (7.1), business-trip
  orders, company-level setup (2.1), MUN-regime calc (flag stored), advances,
  EDS tax-book/sick-leave
  auto-import (manual monthly entry today).
- **Fixed assets (§6.5)** — asset register, accounting + tax depreciation with
  automatic postings, disposal.
- **Warehouse / inventory (§6.4)** — receipts/issues/transfers, FIFO, batches,
  cost, links to purchase/sales.
- **Annual report + closing (§6.8)** — period-closing entries, retained-earnings
  rollover, balance sheet, P&L per LR accounting rules.
- **UIN (corporate income tax) and MUN (micro-enterprise tax) (§6.2)** — today
  VAT is the only tax; both are alternative regimes to model.
- **Multi-currency (§6.1)** — single base currency per client today; add FX and
  exchange-rate differences.
- **Assistant capabilities (§6.9)** — cash-flow forecast, anomaly/fraud
  detection, proactive deadline reminders. The agentic chat + tools exist
  (`src/assistant/`); these are new tools/jobs on top.

Smaller VAT gaps to fold in: reverse charge / intra-EU, exemptions, monthly-vs-
quarterly periodicity logic.

---

## Cross-cutting, before or alongside the above

> **Production-readiness go-live work, closed 2026-07-19** (see
> `docs/audit/PRODUCTION-READINESS.md` for the original blocker/gap list and
> `docs/RUNNING.md` §3 for the Neon+Vercel deploy runbook this unblocked):
> - ~~No user provisioning over HTTP; no 2FA enrolment~~ **FIXED** — invite-based
>   provisioning (`src/auth/invites.ts`, `migrations/033_user_invites.sql`):
>   `npm run provision-admin` (CLI, first admin only) or **Admin → Users**
>   (`POST /api/admin/users`, `users.write`) issue a single-use, 72h `/invite/<token>`;
>   the `/invite/[token]` page collects a password and enrols TOTP via QR before
>   the account activates.
> - ~~Blob storage is local-disk only (uploads lost between invocations)~~
>   **FIXED** — `VercelBlobStore` (`src/blob/vercel-blob-store.ts`), selected by
>   `makeBlobStore()` whenever `BLOB_READ_WRITE_TOKEN` is set
>   (`src/blob/factory.ts`), `LocalBlobStore` remains the dev/test default.
>   Private access; a cache-bypass fix (`useCache: false` on read) ships
>   alongside so an overwritten key (the invoice logo) never serves stale bytes.
> - ~~No login rate limiting / lockout~~ **FIXED** — 5 failures / 15 minutes,
>   tracked per email *and* per IP (`src/auth/rate-limit.ts`), wired into
>   `POST /api/auth/login` and the invite-accept route, fail-closed on limiter
>   errors.
> - ~~Session cookie missing `secure: true`; no security headers~~ **FIXED** —
>   `secure: true` in production on the session cookie
>   (`web/app/api/auth/login/route.ts`); HSTS, `X-Content-Type-Options`,
>   `X-Frame-Options: DENY`, `Referrer-Policy` on every response
>   (`web/next.config.ts`).
> - ~~No `/api/health` route; pool has no `max`/timeouts~~ **FIXED** —
>   `GET /api/health` (`web/app/api/health/route.ts`, `SELECT 1`); pools capped
>   at `max: 5` with `connectionTimeoutMillis`/`idleTimeoutMillis`
>   (`src/db/pool.ts`), sized for Neon's pooled endpoint under serverless
>   concurrency.
>
> Still open from that audit (not blocking a pilot, but real gaps): **GDPR**
> data export/erasure, **audit-log tamper detection (hash chain)**, ~~**expired
> session cleanup**~~ **FIXED 2026-07-19** (opportunistic sweep on login),
> **e-signature**, and a real **password-reset UI** (today an admin re-invites
> the user via Admin → Users, which resets credentials + 2FA — there's no
> self-service "forgot password" flow).

- **GDPR (§7/§9)** — data export + erasure workflows; none exist.
- **E-signature (§6.7)** — document signing; not implemented.
- **Push dispatch** — `src/push/device-tokens.ts` queues, but no APNs/FCM send.
- **Native mobile app + offline queue (§4.3)** — today it's a responsive web
  app with camera capture (added in the adapt pass); the spec wants a native
  app with offline photo queueing.
- **Open API + marketplace (§9, Phase 4)** — future ecosystem.
- ~~**Rate limiting on login, audit-log tamper detection (hash chain)**~~ — rate
  limiting **FIXED 2026-07-19** (see above); the audit-log hash chain remains open.
- ~~**Role-gating on mutating API routes**~~ **FIXED 2026-07-19** — the `Operation`
  matrix (`src/authz/policy.ts`) is the single auditable policy and now also covers
  `tasks.write` + `documents.capture` (all four roles; unknown roles denied) and the
  admin mutations `clients.write`/`tariffs.write`/`templates.write` (firm_admin only).
  Enforcement sits at each surface: task routes inline, document capture in the shared
  `src/api/capture-handler.ts` (web + mobile), admin POSTs via `isRoleAllowed`, and
  `proposals.decide` in the shared `src/api/handlers.ts` (as before). Notifications
  read/read-all and the assistant stay deliberately ungated (self-scoped, per-user).
  Migration-number collisions are now CI-guarded
  (`tests/db/migration-numbering.test.ts` — the four historical 023–026 pairs
  are grandfathered; new collisions fail).
- **Uniform error-status mapping** — most routes map caught errors to
  `/session/i ? 401 : 403`. The einvoices POST additionally maps validation/
  posting failures to 400. Other mutating routes (e.g. parties POST on a
  duplicate `UNIQUE(client, kind, reg_no)`) return 403 for what is really a
  400/409. ~~**Fold a shared error→status helper in when hardening.**~~ **FIXED 2026-07-19** — all web routes now use `errorToStatus`. One
  exception: the shared `authed()` wrapper in `src/api/handlers.ts` keeps its
  own local `/session/i ? 401 : 403` mapping rather than calling the helper —
  currently equivalent since `resolveTenantContext` only ever throws one of
  two messages, but fold it into `errorToStatus` the next time that file changes.
- **Hobby-release follow-ups (final branch review, 2026-07-19)** — none blocking,
  triaged post-merge:
  1. ~~**Prune/cap `login_attempts`**~~ **FIXED 2026-07-19** (attacker-chosen identifiers grow the table
     unbounded; fold into the session-row cleanup debt).
  2. ~~**`POST /api/admin/users`: friendly duplicate-email message**~~ **FIXED 2026-07-19** instead of raw
     `e.message` pass-through (leaks constraint names; cross-firm email oracle
     for firm_admins).
  3. ~~**Firm-scope `clientCompanyIds` in the admin invite route**~~ **FIXED 2026-07-19** (currently inert —
     `resolveTenantContext` re-filters — but cheap defense-in-depth).
  4. ~~**Health/startup signal when `VERCEL_ENV` is set without `BLOB_READ_WRITE_TOKEN`**~~ **FIXED 2026-07-19** (today the first upload 500s with EROFS).
  5. ~~**Skip or scope the `ip:unknown` limiter identifier off-Vercel**~~ **FIXED 2026-07-19** (shared
     lockout bucket for headerless clients). Login route: fixed properly — a
     null IP now falls back to email-only identifiers, so headerless clients
     no longer share a bucket. Invite route: deliberately still uses the
     shared `ip:unknown` bucket, because IP is the *only* identifier available
     there — skipping the limiter for headerless clients would remove rate
     limiting entirely, and a shared fail-closed bucket beats no limiting.
  6. ~~**Route-level limiter tests, bootstrap `VERCEL_ENV` guard test, index on `user_invites.user_id`**~~ **FIXED 2026-07-19** (900s boundary, combined identifiers).
  7. ~~**Cosmetics for the next `/simplify` pass: stale "fail open" comment in the login route, hardcoded busy-ellipsis glyph, `admin.onb.error` key reuse, invite-route GET/POST try-catch symmetry.**~~ **FIXED 2026-07-19**
  Accepted trade-offs (documented, no action): invited-login timing
  side-channel, unrestricted created-role (product decision), invite token in
  URL path (72h/single-use), blob-not-found → 400 mapping (pre-existing
  pattern).

---

## Conventions (so the next person matches the codebase)

- **Domain logic** in `src/<module>/`, pure functions taking `(tx, ctx, ...)`;
  every mutation calls `appendAudit(...)`. RLS is enforced at the DB layer via
  `withTenant(ctx, ...)` — never bypass it.
- **Money** as integer cents through `src/db/money.ts`; never floats.
- **Web API routes** (`web/app/api/.../route.ts`): `getSessionToken()` →
  `resolveTenantContext(token, clientCompanyId, nowUnix())` → domain call inside
  `withTenant`. Copy an existing route; keep the 401/403 mapping.
- **Ledger is append-only** (DB triggers). Corrections are reversals, not edits.
- **i18n**: every user-facing string goes in all three catalogs in
  `web/app/lib/i18n.ts` (typed `Record<keyof typeof EN, string>` — TS fails the
  build if a language misses a key). Dates via `LOCALE_FOR[lang]`.
- **Icons**: inline stroked SVG, `currentColor`, ~1.5px — see
  `web/app/components/NavIcon.tsx`. No emoji, no icon-font.
- **External integrations** stay behind an interface with a stub for tests —
  mirror `AccessPoint`/`StubAccessPoint` and `VidClient`.
- **New feature = migration + domain + tests + API route + page**, in that order.
  Run `npm test` (root) and `npx tsc --noEmit` in both root and `web/`.

## First decisions to unblock work (spec §10)

1. Peppol connection model + accredited provider (#1).
2. VID/EDS connection method + the exact norm/form list, with an accountant (#2).
3. Bank list + statement formats for MVP integrations.
4. Monetisation model (drives tariffs/templates in admin, #4).
5. AI approach — own models vs. external API with a private data boundary.

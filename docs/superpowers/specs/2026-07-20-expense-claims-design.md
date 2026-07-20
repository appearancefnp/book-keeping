# M6 — Expense claims / reimbursements (employee self-service, bank payout)

Date: 2026-07-20. Status: approved for planning.

## Problem

The last fully-absent Tier 1 item in `docs/ROADMAP-market-gaps.md`: employees pay
for things out of pocket (receipts, mileage) and there is no claim → approve →
reimburse workflow. OCR intake exists but routes straight to vendor-bill posting
proposals; payroll exists but has no reimbursement notion; nothing links a
cabinet user to a payroll employee.

## Decisions (locked in brainstorming)

1. **Employee self-service v1** — the client-employee role submits their own
   claims; accountants can enter claims on anyone's behalf.
2. **Bank-payment reimbursement v1** — pain.001 to the employee's IBAN +
   settlement mirroring payables; the payroll-component path is out of scope.
3. **Mileage included** — typed line: km × per-client rate, no VAT.
4. **Per-line input-VAT flag, default off** — deductible VAT (5722) only when
   the accountant marks the receipt as a proper tax invoice; otherwise the
   gross amount books to expense.

## Architecture

Mirror the bills machinery in a new module — claims are "bills whose payee is
your employee": proposal-gated posting through the existing approval queue,
payables-style settlement. Rejected alternatives: employees-as-vendor-parties
reusing payables end-to-end (pollutes vendor space, corrupts AP aging
semantics, mileage doesn't fit the bill-line model); payroll-component payout
(couples reimbursement to run cadence).

House conventions apply throughout: migration + domain (`src/expenses/`) +
tests + API routes + page; integer cents; `withTenant` + `appendAudit` on every
mutation; RLS on every new table; i18n in all three catalogs; stroked-SVG nav
icon.

## Migration `043_expense_claims.sql`

- `employees.user_id uuid NULL REFERENCES users(id)` + partial unique index
  `(client_company_id, user_id) WHERE user_id IS NOT NULL` — the self-service
  link. `employees.iban text NULL` — payout target (payroll has none today).
- `expense_claims`: id, client_company_id, employee_id → employees, status
  `CHECK (status IN ('draft','submitted','approved','reimbursed','rejected'))`
  default `'draft'`, description, total_net_cents, total_vat_cents,
  total_cents (all bigint, maintained by the domain, gross = net + vat),
  currency char(3) default 'EUR' (base-currency only v1),
  posting_proposal_id uuid NULL REFERENCES proposals(id),
  journal_entry_id uuid NULL REFERENCES journal_entries(id),
  reimbursed_at / reimbursement_entry_id uuid NULL, created_at. Index on
  (client_company_id, status, created_at).
- `expense_claim_lines`: id, client_company_id, claim_id → expense_claims,
  line_no int, kind `CHECK (kind IN ('receipt','mileage'))`, line_date date,
  description, expense_account text, net_cents bigint, vat_cents bigint
  default 0, vat_deductible boolean default false, document_id uuid NULL
  REFERENCES documents(id), km numeric NULL, rate_cents bigint NULL
  (mileage lines: net_cents = round(km × rate_cents), vat_cents = 0,
  vat_deductible = false; receipt lines: km/rate NULL).
- `expense_settings`: client_company_id PK, mileage_rate_cents_per_km bigint
  NOT NULL default 30. Read creates the default row on first access
  (mirror `payroll_settings` idiom).
- `ALTER` documents source CHECK to add `'expense'`.
- RLS ENABLE+FORCE + `_tenant_isolation` policy on
  `current_setting('app.current_client_id', true)::uuid` + grants to
  `bookkeeping_app` on all three new tables (copy `037_receivables.sql`).

## Domain `src/expenses/`

- `claims.ts` — create/update draft (lines replaced wholesale on update, like
  the composer sends them), `getClaim`, `listClaims(filter: {status?,
  employeeId?})`, `deleteDraft`. Totals recomputed server-side from lines;
  mileage line net computed from km × the client's current rate at save time
  (rate snapshot stored on the line via rate_cents). All money BigInt.
- `submit.ts` — `submitClaim`: draft → `submitted`, creates a `posting`
  proposal (payload `{ kind: 'expense_claim', claimId }`, human rationale
  listing lines/totals — mirror `createBill`'s proposal). Claim must have ≥1
  line and a positive total.
- `approve.ts` — wired into the proposal-posting path the way bills are
  (follow `tests/payables/bill-approval.test.ts` → the posting hook): posts
  **DR each line's expense_account (net_cents) · DR `5722` Σ vat_cents of
  vat_deductible lines · CR `5610` total_cents (gross)**; claim →
  `approved`, journal_entry_id set. Rejecting the proposal returns the claim
  to `draft` (reason surfaces via the proposal's rejection reason).
- `reimburse.ts` — `buildReimbursementOrder(claimIds)`: pain.001 for the
  employees' IBANs (reuse `src/banking/sepa.ts` builder; error if an
  employee lacks an IBAN); `settleClaim(claimId, {method: 'manual'|
  'bank_match', bankTransactionId?, paidDate})`: posts DR `5610` / CR `2620`
  for total_cents, claim → `reimbursed`, dedup per bank transaction (mirror
  `settleReceivable`'s guard). Bank-debit auto-matching against approved
  claims by exact amount joins the existing matcher family
  (`proposeApMatches` pattern) — propose-time dedup so two equal debits
  can't both claim one claim.
- `settings.ts` — get/set mileage rate (audited).
- Account codes: `EXPENSE_SETTLEMENT_ACCOUNT` default `'5610'`,
  `EXPENSE_VAT_INPUT_ACCOUNT` default `'5722'`, bank `'2620'` — env-overridable
  constants in the routes like bills; extends the documented account-mapping
  debt (same bucket, accountant to confirm LR codes).

## Self-service boundary & authz

- Domain guard: client-side roles are self-scoped for WRITES — when
  `ctx.actorRole` is `employee` or `owner`, create/update/submit resolves the
  actor's own employee row via `employees.user_id = ctx.actorId` and refuses
  claims belonging to anyone else. READS: `employee` sees only their own
  claims; `owner` and firm roles see all. Firm roles write for any employee.
  `ctx.actorId` is the user id (already on `TenantContext`).
- New `Operation`s in `src/authz/policy.ts`:
  - `expenses.write` — create/update/submit own draft: `['firm_admin',
    'accountant', 'owner', 'employee']` (employee self-scoped in domain).
  - `expenses.reimburse` — payment order + settle: `['firm_admin',
    'accountant']`.
  - `expenses.settings.write` — mileage rate: `['firm_admin', 'accountant']`.
- Approval rides the existing `proposals.decide` (firm_admin, accountant,
  owner) — an employee structurally cannot approve their own claim.
- Employee↔user linking + IBAN: fields on the payroll employee card
  (accountant-gated by the existing `payroll.write`).

## Receipts & AI prefill

- `POST /api/expenses/upload`: stores the photo via `makeBlobStore()`,
  creates a documents row (source `'expense'`, status `'received'`), does
  **not** enter the intake pipeline (no posting proposal — prevents
  double-booking), then runs the existing `DocumentExtractor` once and
  returns `{documentId, suggestion: {amount?, date?, merchant?}}` for the
  composer to prefill the line (user confirms; Stub extractor returns a
  fixed suggestion in dev/tests).
- The documents page/list queries must not break on the new source value —
  verify list filters at build time.

## API routes (`web/app/api/expenses/…`, standard pattern + `errorToStatus`)

- `GET/POST /api/expenses` — list (role-scoped) / create-or-update draft.
- `POST /api/expenses/[id]/submit` — submit.
- `POST /api/expenses/[id]/settle` — manual settlement (`expenses.reimburse`).
- `POST /api/expenses/payment-order` — pain.001 for selected approved claims.
- `GET/PUT /api/expenses/settings` — mileage rate.
- `POST /api/expenses/upload` — receipt blob + prefill suggestion.
- Employee link/IBAN ride the existing payroll employee PATCH route.

## UI

- `/expenses` (cabinet page + nav icon): claim list with status badges
  (reuse `PaymentStatusBadge` styling family); composer drawer/page —
  receipt lines (photo attach → prefill, expense account picker, net/VAT +
  deductible toggle) and mileage lines (km × rate, live total); Submit.
  Accountant extras: all-employee list, mileage-rate setting, reimburse
  actions (payment-order download, settle drawer mirroring `/invoices`).
- Approval happens in the existing approval queue (proposal renders the
  claim rationale; a small `ExpenseClaimDetails` payload renderer mirrors
  `BankMatchDetails`).
- Every string in LV/RU/EN.

## Tests (`tests/expenses/`)

Mirror payables coverage: claim CRUD + totals (incl. mileage math and the
rate snapshot); self-scope enforcement (employee A cannot read/write B's
claim; accountant can); submit → proposal payload/rationale; approval posting
(gross/net/VAT-deductible variants — exact cent assertions; posting refused
for empty or non-positive claims); reject → back to draft; settlement (manual
+ bank-match dedup, double-settle refused); pain.001 content for employee
IBAN + missing-IBAN error; settings default-row creation; RLS isolation;
authz matrix rows; upload route stores document without intake proposal.

## Out of scope (documented)

Payroll-component payout, multi-currency claims, per-diem/business-trip
orders, approval limits/policies, receipt e-mail-in (M20), employee
self-service portal beyond claims (payroll §2.3).

# AR money-in loop — design (M4 slice A)

Date: 2026-07-13. Status: approved for planning.

Slice A of the M4 "AR lifecycle" market gap (`docs/ROADMAP-market-gaps.md`). M4 is
decomposed into: **A — AR money-in loop (this doc)**, B — dunning/reminders + late fees,
C — recurring invoices, D — quotes→invoice. A is the foundation the others build on and
has no external dependency and no scheduler requirement.

## Problem

The money-out side (M2) shipped a full open-item loop: `bills` + `bill_payments` +
`settleBill` + `apAging` + camt.053 debit matching. The money-in side has **no
equivalent**. Outbound invoices (`einvoices`, `direction='outbound'`) store no
`customer_party_id`, no payment **due date** (only `vid_due_date`, the VID filing
deadline), and no paid/partial/outstanding status. There is no AR settlement path; the
GL-level AR matcher (`src/banking/match.ts` `proposeMatches`) matches on account balance,
is not invoice-linked, and is unwired from the app (only `src/dev/seed.ts` calls it). There
is no `arAging` (M5's AR half is still ⛔).

Every M4 headline feature (dunning, statements, late fees, aged AR) depends on knowing
which invoices are outstanding and overdue per customer. Slice A builds that foundation as
a faithful mirror of the M2 money-out loop.

## Scope

In scope:
- Persist `customer_party_id` + payment `due_date` on outbound receivables.
- AR settlement (`settleReceivable`) — manual and bank-match methods.
- Invoice-linked AR bank matching wired into the bank-import flow; retire the unused
  GL-level `proposeMatches`.
- AR aging (`arAging`) + aged-receivables tab on `/reports` (completes M5's AR half).
- Customer default payment terms on `parties`.

Explicitly deferred (later slices):
- Invoice-outbox paid/outstanding + due-date columns and a settle UI.
- Customer statement view.
- Dunning/reminders + late fees (B), recurring invoices (C), quotes→invoice (D).

## 1. Data model — `migrations/032_receivables.sql`

Extend `einvoices` (the outbound row *is* the receivable, mirroring `bills` for payables):
- `customer_party_id uuid REFERENCES parties(id)` — nullable (inbound rows leave it null).
- `due_date date` — customer payment due date; distinct from existing `vid_due_date`.
- `amount_paid_cents bigint NOT NULL DEFAULT 0`.
- `status text` — `open | partially_paid | paid | void`; **nullable, no table default**. Set
  to `open` only on the outbound issue path; inbound rows stay null so they never surface in
  AR. (No `awaiting_approval` — unlike bills, issuing an invoice is not proposal-gated: the
  composer issues directly, so a receivable is born `open`.)
- Index for aging: `(client_company_id, direction, status, due_date)`.

New `invoice_payments` table (mirrors `migrations/031_bill_payments.sql`):
`id, client_company_id, einvoice_id (FK einvoices), amount_cents bigint, paid_date date,
method text (bank_match|manual), bank_transaction_id (FK, nullable), journal_entry_id (FK),
cleared_at (nullable)`. Full RLS: `client_company_id` FK, `ENABLE/FORCE ROW LEVEL SECURITY`,
`_tenant_isolation` policy on `current_setting('app.current_client_id')`, grants to
`bookkeeping_app`.

Add `parties.payment_terms_days int` (nullable; treated as e.g. 14 when unset) as the
per-customer default used to compute an invoice due date at compose time.

Migration number: highest existing is `031`; this is `032`. (Note the repo has duplicate
numbers at 023–026; 032 is unused.)

## 2. Domain — new `src/receivables/` module (mirrors `src/payables/`)

All functions `(tx: PoolClient, ctx: TenantContext, ...)`, Zod input schemas, `appendAudit`
on every mutation, money via `src/db/money.ts`.

- **`receivables.ts`** — `ReceivableRow` (with `status` as a union type), `getReceivable`,
  `listReceivables`, `outstandingCents(row)`, `voidReceivable`.
- **`settlement.ts`** — `settleReceivable(tx, ctx, { einvoiceId, amountCents, paidDate,
  method, bankTransactionId?, bankAccount, receivableAccount })`: posts `DR bankAccount /
  CR receivableAccount`, INSERTs `invoice_payments`, advances `open→partially_paid→paid` by
  comparing `amount_paid_cents` vs `grand_total_cents`. Rejects settlement of a
  void/already-paid invoice and over-payment beyond outstanding. Dedup guard: a given
  `bank_transaction_id` cannot settle twice (mirrors the M2 AP-match dedup fix).
- **`aging.ts`** — `arAging(tx, ctx, { asOf })` → `ArAging { current, d1_30, d31_60, d61_90,
  d90plus, total }`, over outbound einvoices where `status IN ('open','partially_paid')`,
  bucketed by `asOf − due_date`. Mirror `src/payables/aging.ts` bucket boundaries exactly.
- **`ar-match.ts`** — `proposeArMatches(tx, ctx, { bankAccount, receivableAccount })`: find an
  unmatched **credit** bank txn, find an open receivable of equal outstanding amount, create a
  `bank_match` proposal linked to the einvoice (mirror `src/payables/ap-match.ts`
  `proposeApMatches`). Propose-time dedup so two equal-amount receivables aren't both matched
  to one debit and vice-versa.

Issue-time persistence: extend `src/einvoice/outbound.ts` `sendInvoice` args with
`customerPartyId` + `dueDate`, and write them (plus `status='open'`) into the `einvoices`
INSERT.

## 3. Wiring & retirement

- `web/app/api/bank/import/route.ts` calls `proposeArMatches` alongside the existing
  `proposeApMatches`.
- The approved-`bank_match` confirm path (`src/banking/confirm-match.ts` and/or the central
  approver in `src/api/handlers.ts`) calls `settleReceivable` when the proposal targets an
  outbound einvoice (AR), keeping the existing AP and GL branches intact.
- **Retire** `proposeMatches` (GL-level) in `src/banking/match.ts` — only referenced by
  `src/dev/seed.ts`; replace the seed usage with `proposeArMatches`.

## 4. API routes + UI

- **`web/app/api/reports/ar-aging/route.ts`** — GET; mirror `web/app/api/reports/ap-aging`.
  `getSessionToken` → `resolveTenantContext` → `assertRoleAllowed` → `withTenant` →
  `errorToStatus`.
- **`web/app/api/receivables/[id]/route.ts`** — POST manual settle (`method='manual'`) and
  void. Role-gated reusing the existing `einvoice.issue` role (no role-map migration). UI for
  this is deferred; the endpoint completes the loop now.
- **Compose path** — `POST /api/einvoices` and `/invoices/new` capture `customer_party_id`
  (already picked from parties) and compute `due_date` from the customer's
  `payment_terms_days` (overridable in the composer). `GET /api/parties` returns
  `payment_terms_days`; the parties editor gains a terms field.
- **UI — aged-receivables tab on `/reports`** (`web/app/(cabinet)/reports/page.tsx`): mirror
  the aged-payables tab — asOf picker, buckets table, tabular numerals, balanced styling. All
  user-facing strings added to **all three** i18n catalogs in `web/app/lib/i18n.ts` (typed
  record — the build fails if a language misses a key).

Account defaults: receivable account `'2310'` (per `web/app/api/einvoices/route.ts`), same
hard-coded-default posture as M2's AP accounts (per-client account-mapping screen remains a
tracked deferred item).

## 5. Testing

- Domain: `tests/receivables/settlement.test.ts` (full, partial, over-payment rejection,
  void/paid rejection, bank-txn dedup), `tests/receivables/aging.test.ts` (bucket boundaries),
  `tests/receivables/ar-match.test.ts` (amount match, no double-settle), and issue-time
  persistence of `customer_party_id` + `due_date` in an outbound-invoice test.
- API: `tests/api/ar-aging.test.ts` and the settle route via the handler-test pattern.
- Regression gate: `npm test` (root) all green; `npx tsc --noEmit` clean in root **and**
  `web/`; `npm run build` in `web/` clean.

## Conventions followed

`migration + domain (src/<module>/) + tests + API route + page`; RLS via `withTenant`, never
bypassed; ledger append-only (settlement posts entries, never edits); integer cents; i18n in
all three catalogs; inline stroked SVG icons. Mirrors `src/payables/` (M2) throughout so the
money-in loop is symmetric with the money-out loop.

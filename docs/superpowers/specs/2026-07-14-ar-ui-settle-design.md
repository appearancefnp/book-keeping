# AR money-in UI — receivable status + settle (M4 slice A, UI)

Date: 2026-07-14. Status: approved for planning.

Surfaces the M4 slice A "money-in loop" (`docs/superpowers/specs/2026-07-13-ar-money-in-loop-design.md`)
in the UI. The backend shipped API-only: `einvoices` now carry `status`/`due_date`/
`amount_paid_cents`, `settleReceivable` posts settlements, and `POST /api/receivables/[id]`
(`action: 'settle' | 'void'`) exists — but nothing on `/invoices` shows payment status or lets a
user settle. This slice closes that gap.

## Problem

The `/invoices` list is fed by `listEinvoices` (`src/einvoice/query.ts`), which does not select
the AR columns M4-A added, so an outbound invoice's payment status, due date, and outstanding
balance are invisible. Settling is possible only by calling the API directly. Users cannot see
which invoices are paid/overdue or record a payment from the UI.

## Scope

In scope:
- Surface payment **status**, **due date**, and **outstanding** on the `/invoices` list (outbound
  rows only; inbound rows show "—").
- A **Settle** action on unpaid outbound rows opening a drawer that records a manual payment or
  voids the invoice, wired to the existing `POST /api/receivables/[id]`.

Explicitly deferred (later slices):
- Customer statement view (per-customer outstanding + payment history).
- Status/overdue filter on the list.
- A `/invoices/[id]` detail page (the AP side has `/bills/[id]`; AR stays lighter for now).
- Dunning/reminders + late fees (B), recurring invoices (C), quotes→invoice (D).

## Approach

Chosen: **extend `listEinvoices` with the AR columns** (Approach A). `einvoices` *is* the
receivable table, so the columns belong on its query; the list keeps its single existing fetch
(`/api/einvoices`) and data flow. Rejected: a separate `GET /api/receivables` list route with a
client-side merge (two fetches, no gain — same table), and a dedicated `/receivables` page (two
places listing outbound invoices, fragmented UX).

## 1. Data — `src/einvoice/query.ts`

Extend the `listEinvoices` SELECT with columns already present on `einvoices`:
- `status` (nullable — inbound rows are null).
- `to_char(due_date,'YYYY-MM-DD') AS due_date`.
- `amount_paid_cents::text`.
- `(grand_total_cents - amount_paid_cents)::text AS outstanding_cents`.

Add the four fields to the `EinvoiceRow` type (all nullable: `status: ReceivableStatus | null`,
`dueDate`, `amountPaidCents`, `outstandingCents: string | null`) and to the row mapping. No new
query, no new route — `GET /api/einvoices` returns them automatically. `ReceivableStatus` is
reused from `src/receivables/receivables.ts`.

## 2. List UI — `web/app/(cabinet)/invoices/page.tsx`

- Mirror the four new fields into the client-side `EinvoiceRow` interface.
- Three new columns after **Total**: **Payment** (status pill), **Due**, **Outstanding**
  (right-aligned, tabular numerals, currency-formatted via `formatCents`). Inbound rows and
  outbound rows with null status render "—".
- **Settle** action in the trailing actions cell, shown only for outbound rows whose status is
  `open` or `partially_paid`. Clicking sets the drawer's target row.
- The table keeps its existing `styles.tableWrapper` (horizontal scroll) as it grows to ~10
  columns.

New `PaymentStatusBadge` component (`web/app/components/`), a small pill with a CSS-module class
per status (`open` / `partially_paid` / `paid` / `void`) and an i18n label. Kept separate from the
proposal-type `StatusBadge`, which is a different domain.

## 3. Settle drawer

State-driven `role="dialog"` drawer mirroring the `payroll/runs/[id]` pattern (overlay-click and a
Cancel button close it; `aria-modal="true"`). May live inline in `page.tsx` or as a small
`SettleDrawer` component — implementer's choice.

Fields:
- **Amount** — prefilled to the row's `outstandingCents`, editable, currency-formatted input.
- **Paid date** — date input prefilled to today.
- Primary **Settle** button → POST `action: 'settle'`.
- Secondary **Void** button, shown only when status is `open` → POST `action: 'void'`.

Request body to `POST /api/receivables/[id]`: `{ clientCompanyId, action, amountCents, paidDate }`
(amount/date omitted for void). On success: close the drawer and re-fetch the list (`load()`). On
failure: surface the server error message inline in the drawer. Backend guards (over-payment,
settling a void/paid invoice, bank-txn dedup) are authoritative; the UI only displays their
messages. The route is role-gated on `einvoice.issue` (already in place).

## 4. i18n — `web/app/lib/i18n.ts`

New keys in **all three** catalogs (en/lv/ru; the typed record fails the build if a language misses
a key):
- Column headers: payment, due, outstanding.
- Payment status labels: open, partially_paid, paid, void.
- Drawer: title, amount label, paid-date label, settle, void, cancel.
- Feedback: settle-success and settle-error text.

## 5. Testing & gates

- Extend the `listEinvoices` query test to assert the four new fields: populated on an outbound
  receivable, null on an inbound row.
- The settle/void route (`POST /api/receivables/[id]`) already has coverage from M4-A; no new
  domain logic is added here.
- Gate: `npm test` (root) green; `tsc --noEmit` clean in root **and** `web/`; `npm run build` in
  `web/` clean.
- Manual verification: issue an outbound invoice, confirm the status/due/outstanding columns and
  the pill render; settle a partial then full amount and watch status advance
  `open → partially_paid → paid`; void an open invoice.

## Conventions followed

Additive over the shipped M4-A backend (no migration, no new domain logic). i18n in all three
catalogs; inline stroked SVG icons; existing component/CSS-module patterns
(`payroll/runs/[id]` drawer, `formatCents`, `tableWrapper`). Per `web/AGENTS.md`, read the bundled
Next.js docs (`node_modules/next/dist/docs/`) before editing the page.

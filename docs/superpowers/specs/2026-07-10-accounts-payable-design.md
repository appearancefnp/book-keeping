# Accounts Payable (M2) — Design

Date: 2026-07-10. Design for **M2 — Accounts payable / vendor bills** from
`docs/ROADMAP-market-gaps.md` (Tier 1, the credibility floor). This is the
money-*out* half of bookkeeping; the app has AR (invoicing) but no bill workflow
at all today.

**Scope decision (agreed):** the **full money-out loop** in one design — bill
entity + entry + approval-gated posting + AP list + AP aging + pay run (pain.001)
+ settlement + camt.053 bank-match settlement. Nothing deferred to a follow-on.

**Goal:** enter supplier bills (manually, or adopted from the OCR/Peppol intake
that already exists), track what is owed and when, pay open bills in a batch that
emits a SEPA pain.001 file, and settle bills against the bank statement — all on
the existing append-only ledger, approval queue, and tenancy substrate.

---

## Context — what already exists (reused, not rebuilt)

- **Parties** (`src/parties/parties.ts`) already has a `vendor` kind.
- **The purchase posting already exists**: `extractedToJournalEntry`
  (`src/intake/map-posting.ts`) produces the exact AP double-entry —
  *DR expense (net) / DR VAT-input (vat) / CR payables (gross)* — and is used by
  both OCR document intake and Peppol inbound (`src/einvoice/inbound.ts`).
- **Approval substrate**: inbound invoices / OCR docs already create a `posting`
  proposal (`createProposal`, `src/proposals/proposals.ts`) that flows through the
  approval queue with rationale.
- **Pay-out rail**: `generateSepaCreditTransfer` (pain.001) in
  `src/banking/sepa.ts`, surfaced at `/bank`.
- **Settlement precedent**: `postApprovedBankMatch` (`src/banking/confirm-match.ts`)
  settles a *receivable* (DR bank / CR receivable) from a matched camt.053 credit
  and marks the bank transaction `reconciled`. AP settlement is the mirror.
- **`einvoices`** tracks inbound/outbound Peppol invoices as transport documents —
  no due date, no open/paid lifecycle, no per-bill outstanding.

**The gap M2 fills:** there is no **bill entity** with a lifecycle. Purchase
invoices post a lump into the payables account; you cannot see which bills compose
it, what is due when, or settle a specific bill. Everything else needed already
exists.

---

## Design decisions (agreed during brainstorming)

1. **Full money-out loop** in a single design (largest scope; touches `banking/`,
   `sepa.ts`, `match.ts` alongside the new module).
2. **First-class `bills` table + approval-gated posting.** Bill entry (manual,
   OCR, or Peppol) creates a bill row (`awaiting_approval`) linked to a `posting`
   proposal. Approving posts the payable and flips the bill to `open`. One posting
   path; nothing new in the approval queue.
3. **Bank-clearing (payments-in-transit) account** for settlement. The payable is
   cleared exactly once at pay-run initiation; the in-flight amount is visible in
   the ledger and cleared when the camt.053 debit lands.
4. **Partial payments supported.** A bill tracks `amount_paid_cents`;
   `outstanding = grand_total − amount_paid`; status flows
   `awaiting_approval → open → partially_paid → paid` (plus `void`).

---

## Module boundary

One new domain module, **`src/payables/`**:

| File | Responsibility |
|------|----------------|
| `src/payables/bills.ts` | Bill entry (create bill + lines + linked `posting` proposal), query/list, get, void. |
| `src/payables/settlement.ts` | Record a `bill_payments` settlement + post the settlement entry; maintain `amount_paid_cents` / status. Partial-aware. |
| `src/payables/pay-run.ts` | Select open bills → post DR payables / CR bank-clearing per bill, create `bill_payments(method=pay_run)`, emit one pain.001. |
| `src/payables/aging.ts` | AP aging buckets from the `bills` table, by `due_date` vs `asOf`, summing outstanding. |
| `src/payables/query.ts` | Read models for the UI (bill list rows, bill detail with lines + payments, pay-run list). |

Reused / extended:
- **`src/intake/map-posting.ts`** — generalized to support **per-line expense
  accounts** (today a single `expenseAccount`; a real bill splits across
  categories). Backward compatible.
- **`src/proposals/post-proposal.ts`** (or the approve path) — extended so that
  posting a `posting` proposal *linked to a bill* also sets the bill's
  `journal_entry_id` and status → `open`.
- **`src/banking/match.ts`** — extended so camt.053 **debits** match (a) a pay-run
  payment → clear transit, or (b) an open bill → settle directly.
- **`src/parties/parties.ts`** — add `iban` (needed to include a vendor in a pay
  run).

---

## Data model — migration `030_bills.sql`

All tables follow the house RLS pattern (`client_company_id`, tenant-isolation
policy, `FORCE ROW LEVEL SECURITY`, `GRANT` to `bookkeeping_app`) as in
`015_einvoices.sql`. Money is integer cents (`bigint`).

### `bills`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid pk | |
| `client_company_id` | uuid | FK `client_companies`, RLS key |
| `vendor_party_id` | uuid | FK `parties(id)` |
| `bill_number` | text | vendor's invoice number |
| `issue_date` | date | |
| `due_date` | date | drives aging |
| `currency` | char(3) | |
| `net_cents` | bigint | |
| `vat_cents` | bigint | |
| `grand_total_cents` | bigint | |
| `amount_paid_cents` | bigint | default 0; Σ of `bill_payments` |
| `status` | text | CHECK `awaiting_approval\|open\|partially_paid\|paid\|void` |
| `source` | text | CHECK `manual\|ocr\|peppol` |
| `posting_proposal_id` | uuid | FK `proposals(id)` — the approval-queue proposal |
| `journal_entry_id` | uuid null | FK `journal_entries(id)`; set when approved/posted |
| `document_id` | uuid null | OCR origin (FK `documents`) |
| `einvoice_id` | uuid null | Peppol origin (FK `einvoices`) |
| `created_at` | timestamptz | default `now()` |

`outstanding` is derived (`grand_total_cents − amount_paid_cents`), not stored.
Index on `(client_company_id, status, due_date)` for the list + aging.

### `bill_lines`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid pk | |
| `client_company_id` | uuid | RLS key |
| `bill_id` | uuid | FK `bills(id)` |
| `line_no` | int | ordering |
| `description` | text | |
| `expense_account` | text | account code to DR |
| `net_cents` | bigint | |
| `vat_rate` | numeric | |
| `vat_cents` | bigint | |

Lets manual entry split a bill across expense accounts and preserves the bill's
own line view independent of the journal.

### `bill_payments`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid pk | |
| `client_company_id` | uuid | RLS key |
| `bill_id` | uuid | FK `bills(id)` |
| `amount_cents` | bigint | this settlement's amount (≤ outstanding) |
| `paid_date` | date | |
| `method` | text | CHECK `pay_run\|bank_match\|manual` |
| `pay_run_id` | uuid null | FK `pay_runs(id)` |
| `bank_transaction_id` | uuid null | FK `bank_transactions(id)` |
| `journal_entry_id` | uuid | FK `journal_entries(id)` — the settlement entry |
| `created_at` | timestamptz | default `now()` |

### `pay_runs`
| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid pk | |
| `client_company_id` | uuid | RLS key |
| `created_by` | uuid | actor |
| `total_cents` | bigint | sum of the run |
| `pain001_xml` | text | generated file, for re-download |
| `status` | text | CHECK `generated` (room to grow) |
| `created_at` | timestamptz | default `now()` |

### `parties` (alter)
Add `iban text` (nullable). A vendor must have an `iban` to be included in a pay
run; the pay-run builder rejects a selected bill whose vendor has no IBAN.

---

## Ledger flows (cent-safe, append-only; corrections are reversals)

### 1. Entry → approval → open
Creating a bill writes `bills` + `bill_lines` (`awaiting_approval`) and a `posting`
proposal carrying rationale (`ruleRef`, computation `net + vat = grand`,
`sourceRefs` linking bill/document/einvoice). Three sources:
- **manual** — `/bills/new` composer.
- **ocr** — document intake, extended to also create the bill row beside the
  proposal it already makes.
- **peppol** — `receiveInboundInvoices`, likewise extended.

Approving the proposal (existing queue) posts, per the generalized template:

```
DR expense_account (per bill_line, net)   … one line each
DR VAT-input       (Σ vat)
CR payables        (grand_total)
```

then sets `bills.journal_entry_id` and status → `open`. **One posting path** for
all three sources.

### 2. Pay run
Operator selects open / partially-paid bills. For each bill the run posts:

```
DR payables        (amount)
CR bank-clearing   (amount)
```

marks the bill `paid` or `partially_paid`, writes `bill_payments(method=pay_run,
pay_run_id, journal_entry_id)`, and appends the vendor's IBAN + amount +
reference to a single pain.001 via `generateSepaCreditTransfer`. The run row
stores the XML for re-download. Bills whose vendor lacks an IBAN are rejected
before any posting.

### 3. Settlement / clearing via bank
A camt.053 **debit** (money out), imported through the existing bank pipeline,
matches one of two cases (keyed on amount + reference, mirroring the receivable
matcher), surfaced as a `bank_match` proposal and posted on approval:

- **(a) Clears a pay-run payment** →
  `DR bank-clearing / CR bank`. The transit account nets to zero; the bank
  transaction is marked `reconciled`. No change to `amount_paid` (already counted
  at pay-run time).
- **(b) Settles a bill paid outside any pay run** →
  `DR payables / CR bank`, writes `bill_payments(method=bank_match)`, updates
  `amount_paid`/status. This is the direct path for bills never put through a run.

**Sign check (pay-run + clear):** `DR payables / CR bank-clearing` then
`DR bank-clearing / CR bank` nets to `DR payables / CR bank`; the clearing account
returns to zero. ✓

A `manual` settlement method exists for a hand-entered payment (DR payables / CR
bank) without a bank import — same `settlement.ts` path.

---

## Aging

`src/payables/aging.ts` → `apAging(tx, ctx, { asOf })` queries **bills**
(`status IN (open, partially_paid)`), bucketing **outstanding** by `due_date` vs
`asOf`: `current` (not yet due), `1–30`, `31–60`, `61–90`, `90+` days overdue,
plus a total. It reads bills, not the ledger balance, precisely because due dates
and per-bill outstanding do not exist in the payables lump.

---

## API routes

House convention (`web/app/api/.../route.ts`): `getSessionToken()` →
`resolveTenantContext(token, clientCompanyId, nowUnix())` → domain call inside
`withTenant`; error mapping `/session/i.test(msg) ? 401 : 403`, with `400` for bad
input.

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/bills` | GET | list; filters `status`, `vendor` |
| `/api/bills` | POST | create bill (`bills` + `bill_lines` + posting proposal) |
| `/api/bills/:id` | GET | detail: lines + payments + status |
| `/api/bills/:id` | PATCH | edit while `awaiting_approval`; `void` |
| `/api/pay-runs` | POST | create from selected bill ids → posts + returns pain.001 |
| `/api/pay-runs` | GET | list past runs |
| `/api/pay-runs/:id` | GET | re-download the pain.001 XML |
| `/api/reports/ap-aging` | GET | `?asOf=` → aging buckets |

**No new approve route.** Approval reuses the existing proposal-approval endpoint;
the bill transition is a hook in the post-proposal path. **Bank settlement** rides
on the existing bank-match approval flow, extended for debits.

---

## Pages (`web/app/(cabinet)/*`, trilingual EN/LV/RU, stroked SVG icons)

- **`/bills`** — AP list: vendor, `bill_number`, due date, outstanding, status;
  status/vendor filters; "New bill" and "Pay bills" actions. New nav entry +
  `bills` icon; visible to accountant/firm_admin (and owner, read-mostly).
- **`/bills/new`** — manual composer mirroring `/invoices/new`: vendor picker
  (from parties), lines (description + expense account + net + VAT rate), live
  cent-safe totals (reuse the tabular-numeral table styling), submit → queue.
- **`/bills/[id]`** — detail: lines, settlement history, status.
- **Pay run** — reached from `/bills` "Pay bills": select open bills → review
  screen (vendor, amount, IBAN presence) → generate (posts + downloads pain.001);
  past runs listed. Cross-linked from `/bank`.
- **Aged payables** — a new **tab on the existing `/reports` page** (its natural
  home; M5 later adds an AR-aging tab beside it).

i18n: `bills.*`, `payables.*`, `nav.bills` / `nav.short.bills`, aging strings —
all three catalogs (TS build fails on a missing key).

---

## Account codes

Following the `sendInvoice` / intake precedent, the posting, settlement, and
pay-run domain calls take account codes explicitly (payables, VAT-input, bank,
**bank-clearing**). The API layer supplies **LR-chart defaults from a small config
constant**. Two items are explicit assumptions:

- **Exact LR chart codes to confirm with the accountant** (spec §10.1) — the
  defaults are representative, matching the posture of `vat-declaration.ts` and
  `map-posting.ts`.
- **A per-client account-mapping settings screen is deferred** — same bucket as
  tariffs/templates (audit G4). Defaults are used until it exists.

---

## Testing (mirrors `tests/reports/*`; Postgres up; `npm test` + `npx tsc --noEmit` root & web)

Domain unit tests per file:
- **bills.ts** — entry creates `bills` + `bill_lines` + a linked `posting`
  proposal; `awaiting_approval`; void.
- **post-proposal hook** — approving a bill-linked proposal posts the correct
  **per-line** payable entry and flips the bill to `open` with `journal_entry_id`.
- **settlement.ts** — full settlement → `paid`; **partial** settlement →
  `partially_paid` with correct `amount_paid`/`outstanding`; a second partial that
  completes → `paid`; over-payment rejected.
- **pay-run.ts** — postings (DR payables / CR bank-clearing) per bill; pain.001
  shape; vendor-without-IBAN rejected before any posting; `bill_payments` rows.
- **match.ts (AP)** — camt.053 debit clears a pay-run payment
  (**transit nets to zero**); a non-pay-run debit settles a bill directly; a
  reversal nets out.
- **aging.ts** — buckets by `asOf`; partially-paid bill shows outstanding only;
  paid/void excluded.

---

## Build sequence (migration → domain → tests → API → page)

1. Migration `030_bills.sql` (bills, bill_lines, bill_payments, pay_runs;
   `ALTER parties ADD iban`).
2. Generalize `map-posting.ts` to per-line expense accounts (+test).
3. `payables/bills.ts` — entry + query + void (+tests).
4. Hook post-proposal → update linked bill (+test).
5. `payables/settlement.ts` — bill_payments + settlement postings, partial-aware
   (+tests).
6. `payables/pay-run.ts` — select → postings + pain.001 (+tests).
7. Extend `banking/match.ts` for AP debits (clear transit / settle bill) (+tests).
8. `payables/aging.ts` (+tests).
9. API routes (bills, pay-runs, ap-aging).
10. Pages (`/bills`, `/bills/new`, `/bills/[id]`, pay-run flow, aging tab on
    `/reports`) + i18n + nav/icon.
11. Full verification + docs: mark M2 in `docs/ROADMAP-market-gaps.md` and
    `HANDOFF.md`; note M5 (aged AR/AP) now has the AP half.

---

## Conventions honored

- Domain functions `(tx, ctx, …)` inside `withTenant`; every mutation calls
  `appendAudit`; RLS at the DB layer.
- Money as integer cents via `src/db/money.ts`; never floats.
- Ledger append-only; corrections are reversals; every posting + reversal nets to
  zero in every statement.
- External-facing pieces stay behind existing seams (pain.001 composer, bank
  import); no new integration seams introduced.
- i18n in all three catalogs; stroked `currentColor` icons; tabular numerals.
- New feature = migration + domain + tests + API route + page, in that order.

---

## Out of scope (explicit)

- Credit notes / debit notes against a bill (M7 — its own plan; UBL CreditNote
  type).
- Multi-currency bills / FX on payables (M8).
- Recurring bills / scheduled payments (part of M4-style lifecycle, later).
- Per-client account-mapping settings screen (deferred; defaults used).
- Live bank feeds (M3) — settlement here consumes the existing camt.053 import.

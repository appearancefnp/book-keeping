# Credit Notes (M7) — Design

Date: 2026-07-17. Design for **M7 — Credit notes** from `docs/ROADMAP-market-gaps.md`
(Tier 1, the credibility floor). Credit notes are the basic correction instrument for
both sides of the ledger: reducing what a customer owes us (AR) and what we owe a vendor
(AP). Flagged in `HANDOFF §3` (outbound needs a UBL CreditNote type) and explicitly
punted here by M2 (which rejects negative-amount bills "credit notes are out of scope — see M7").

**Scope decision (agreed):** **both AR and AP** credit notes, in one design. AR =
outbound customer credit notes (UBL CreditNote, reversal posting, Peppol dispatch,
composer UI). AP = vendor credit notes (manual entry + inbound Peppol CreditNote) that
reduce payables.

**Goal:** issue a credit note against a customer (reversing receivable + output VAT),
and record a vendor credit note (reducing payables + input VAT) — both on the existing
append-only ledger, approval queue, VAT engine, and Peppol transport, reusing the
outbound machinery where the lifecycle is genuinely identical and isolating the one new
concept (a payable-reducing document) in its own home.

---

## Decisions (agreed during brainstorming)

1. **Both sides** — AR (outbound) and AP (vendor).
2. **Optional invoice/bill link.** A credit note *may* reference the original document
   (prefills party + lines, emits EN 16931 `BillingReference`), but standalone credit
   notes are allowed (e.g. a volume rebate that maps to no single invoice). The link is a
   stored reference string, not a hard FK to an invoice-balance row (AR has no such row).
3. **Ledger-only, no refund flow.** A credit note always posts its reversal to the
   ledger. Any resulting party balance (over-credit, or a credit with no outstanding
   invoice) simply sits on the receivable/payable account for the accountant to net
   against future documents or settle via the existing bank-match flow. There is **no**
   new "issue refund" (cash out/in) action in M7.
4. **Approach C — hybrid** (each side in its natural home; see below).

---

## Context — what already exists (reused, not rebuilt)

- **Outbound invoice lifecycle** — `sendInvoice` (`src/einvoice/outbound.ts`) validates
  EN 16931, renders UBL, posts *DR receivable / CR sales / CR output VAT*, dispatches via
  `AccessPoint.send`, and records an `einvoices` row (Peppol + VID status, journal link).
  A credit note's outbound lifecycle is **identical** except for the posting signs and the
  document type — so AR credit notes live here.
- **UBL build/parse** — `buildUblInvoice` / `parseUblInvoice` (`src/einvoice/ubl.ts`)
  with party + monetary-total helpers. CreditNote is the same document family with a
  different root element (`CreditNote` / `CreditNoteLine`) and customization/profile IDs.
- **`einvoices` table** — stores inbound/outbound Peppol documents (`direction`,
  `ubl_xml`, `peppol_status`, `vid_status`, `journal_entry_id`). Currently invoices only.
- **AP bill entry** — `createBill` / `buildBillEntry` (`src/payables/bills.ts`) posts
  *DR expense / DR input VAT / CR payables* and creates a `posting` proposal
  (`pending_approval`) through the approval queue. A vendor credit note is the sign-mirror,
  but is **not** a payable you schedule/settle — so it gets a sibling module, not a `bills` row.
- **Inbound routing** — `receiveInboundInvoices` (`src/einvoice/inbound.ts`) parses each
  Peppol message as an Invoice and calls `createBill`. It must learn to detect a CreditNote
  root and route to the vendor-credit-note path instead.
- **VAT engine** — `computeVat` (`src/tax/vat-compute.ts`) sums debits/credits on the
  output/input VAT accounts within a period. Reversal entries (*DR output VAT* on AR,
  *CR input VAT* on AP) automatically reduce the correct totals; **no change needed**.
- **AP aging** — `apAging` (`src/payables/aging.ts`) buckets outstanding on `bills`.
- **Proposals / audit / RLS / tenancy** substrate as used by all modules.

**The gap M7 fills:** there is no credit-note document type at all. AR can only issue
one-off invoices; AP rejects negative bills. Neither side can correct a document.

---

## Approach (C — hybrid)

- **AR credit notes → `src/einvoice/`.** The outbound lifecycle (UBL, EN 16931, Peppol
  dispatch, VID, outbox listing) is identical to an invoice, so credit notes are recorded
  as `einvoices` rows discriminated by a new `doc_type` column, and issued by a new
  `sendCreditNote` that mirrors `sendInvoice` with reversed posting signs.
- **AP vendor credit notes → `src/payables/credit-notes.ts` + a new
  `vendor_credit_notes` table.** A vendor credit note reduces payables but is *not*
  something you pay — it has no `amount_paid`, no pay-run, no settlement. Giving it its
  own table keeps every M2 hardening against negative `bills` intact (we do **not** weaken
  the bill guard) and keeps the pay-run/settlement code untouched.

Rejected alternatives: **(A)** one unified `credit_notes` table for both sides duplicates
the outbound Peppol/VID lifecycle `einvoices` already owns; **(B)** sign-flipping
`sendInvoice`/`createBill` in place re-introduces exactly the negative-amount hazards the
M2 review closed.

---

## Data model

**Migration `032_credit_notes.sql`:**

1. Extend `einvoices` (AR side):
   - `ADD COLUMN doc_type text NOT NULL DEFAULT 'invoice' CHECK (doc_type IN ('invoice','credit_note'))`
   - `ADD COLUMN corrected_invoice_number text` — the optional EN 16931 preceding-invoice
     reference (`BillingReference/InvoiceDocumentReference/ID`). Null for standalone.
   - Existing rows default to `'invoice'`; no data backfill needed.

2. New `vendor_credit_notes` table (AP side), shaped like `bills` **minus** settlement:
   - `id`, `client_company_id` (RLS), `vendor_party_id → parties(id)`,
     `credit_note_number text`, `issue_date date`, `currency char(3)`,
     `net_cents bigint`, `vat_cents bigint`, `grand_total_cents bigint`,
     `corrected_bill_number text` (optional link),
     `status text CHECK (status IN ('awaiting_approval','applied','void'))`,
     `source text CHECK (source IN ('manual','peppol'))`,
     `posting_proposal_id → proposals(id)`, `journal_entry_id → journal_entries(id)`,
     `document_id → documents(id)`, `einvoice_id → einvoices(id)`,
     `created_at timestamptz`.
   - **No** `amount_paid_cents` and no pay-run/settlement columns — a credit note is not paid.
   - Index on `(client_company_id, status, issue_date)`.

3. New `vendor_credit_note_lines` table, mirroring `bill_lines`:
   - `id`, `client_company_id`, `credit_note_id → vendor_credit_notes(id)`, `line_no`,
     `description`, `expense_account`, `net_cents`, `vat_rate numeric`, `vat_cents`.

RLS `ENABLE`/`FORCE` + `tenant_isolation` policy + `GRANT SELECT, INSERT, UPDATE ... TO
bookkeeping_app` on both new tables, copied verbatim from the `bills`/`bill_lines` pattern.
All amounts stored non-negative (magnitudes); the *reversal direction* is expressed by the
posting, never by a negative amount — this is what keeps us clear of the M2 negative hazard.

---

## Posting logic (reversal entries)

Both reversals are the exact sign-mirror of their invoice/bill counterpart, so each
balances by construction and each gets its own unit test.

- **AR credit note** — reverse the sales invoice:
  `DR sales (net) / DR output VAT (vat) / CR receivable (grand)`.
  Implemented in `sendCreditNote` (`src/einvoice/outbound.ts`), mirroring `sendInvoice`:
  validate EN 16931 (credit-note variant) → render UBL CreditNote → post the reversal →
  dispatch via `AccessPoint.send` → insert an `einvoices` row with `doc_type='credit_note'`,
  `corrected_invoice_number` if linked → append audit. Posts **directly** (no proposal),
  role-gated `einvoice.issue` — we control what we issue, exactly as invoices are.

- **AP vendor credit note** — reverse the bill:
  `DR payables (grand) / CR expense (net) / CR input VAT (vat)` (input VAT line omitted
  when vat is zero, matching `buildBillEntry`). Implemented as `buildCreditNoteEntry` (the
  sign-mirror helper) + `createVendorCreditNote` (`src/payables/credit-notes.ts`),
  mirroring `createBill`: insert the credit-note + lines (`awaiting_approval`) → create a
  `posting` proposal (`pending_approval`) with rationale → link the proposal. Approving the
  proposal posts the reversal and flips the credit note to `applied` — inbound documents
  need accountant approval, exactly as bills do.

- **VAT** — `computeVat` is unchanged. AR credit notes debit the output VAT account
  (reducing output VAT); AP credit notes credit the input VAT account (reducing input
  VAT). The netting falls out of the existing sum-by-side query.

- **AP aging** — extend `apAging` (`src/payables/aging.ts`) to subtract `applied` vendor
  credit notes for a vendor as negative outstanding, so aged payables stay correct under
  the ledger-only model (a credit note reduces the vendor's aged balance). Bucketed by the
  credit note's own date; a vendor whose credits exceed bills nets toward/below zero.

---

## UBL (EN 16931 CreditNote)

- Refactor `src/einvoice/ubl.ts` to extract the shared party and `LegalMonetaryTotal`
  helpers, then add:
  - `buildUblCreditNote(cn)` — root `<CreditNote>` in the CreditNote-2 namespace,
    `<CreditNoteLine>` elements, CreditNote customization/profile IDs, and an optional
    `<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>` when linked.
  - `parseUblCreditNote(xml)` — mirror of `parseUblInvoice` reading the `CreditNote` root
    and `CreditNoteLine`s; surfaces `correctedInvoiceNumber` from `BillingReference`.
- `validateEn16931` becomes doc-type-aware (same BR subset: number, issue date, currency,
  supplier VAT, ≥1 line, line-net sums to net total, grand = net + VAT) applied to the
  credit-note shape.
- **Inbound root detection** — `receiveInboundInvoices` inspects each message's root
  element: `Invoice` → `parseUblInvoice` → `createBill` (unchanged); `CreditNote` →
  `parseUblCreditNote` → `createVendorCreditNote`. This is what finally lets a received
  Peppol CreditNote through instead of failing the batch.

---

## API + UI

- **AR:** `POST /api/credit-notes` (sibling to `POST /api/einvoices`) → `sendCreditNote`,
  role-gated `einvoice.issue`. The `/invoices/new` composer gains a **"Credit note"** mode
  with an optional "credit an existing invoice" picker that prefills customer + lines and
  sets `correctedInvoiceNumber`. The outbox at `/invoices` gains a document-type column so
  invoices and credit notes are distinguishable — `listEinvoices` / `EinvoiceRow`
  (`src/einvoice/query.ts`) surface the new `doc_type` field. Chart-of-accounts codes come
  from the same env defaults `/api/einvoices` already uses (receivable/sales/output-VAT).
- **AP:** `POST /api/credit-notes` (AP branch, or a distinct `/api/vendor-credit-notes`)
  → `createVendorCreditNote`, creating the approval proposal. A **"Vendor credit note"**
  entry path near `/bills` (manual line entry, vendor picker, optional corrected-bill
  reference). The `/bills` list and the aged-payables tab on `/reports` reflect the netting.
- Both routes follow the existing route conventions: `resolveTenantContext`,
  `withTenant`, `assertRoleAllowed`, `errorToStatus`. **Read `node_modules/next/dist/docs/`
  before touching web routes** (per `web/AGENTS.md` — this Next.js has breaking changes).

---

## Testing

Follows the house convention (migration + domain + tests + API route + page):

- `buildCreditNoteEntry` — balanced reversal; VAT-zero line omission; rounding remainder.
- AR reversal posting via `sendCreditNote` — DR sales / DR output VAT / CR receivable,
  with a stub `AccessPoint`.
- UBL CreditNote build → parse round-trip, including `BillingReference` presence/absence.
- `validateEn16931` on the credit-note shape (BR failures reported).
- Inbound root detection routes Invoice → bill and CreditNote → vendor credit note.
- `apAging` nets an `applied` vendor credit note as negative outstanding.
- Integration: a period's VAT return nets an AR credit note (output VAT down) and an AP
  credit note (input VAT down) via `computeVat`.

---

## Out of scope (M7)

- **Refunds / cash movement** for over-credits (decision 3 — ledger-only).
- **Multi-currency** credit notes beyond what invoices/bills already do (→ M8).
- **Hard over-credit enforcement** against a running invoice balance — AR has no
  invoice-balance table; the credit simply posts and the balance sits on the account.
- **Credit-note-specific pay-run/settlement** — a credit note is never "paid".

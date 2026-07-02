# MVP Implementation Roadmap (Plans 1–8)

This is the ordered plan sequence for the MVP defined in
`docs/superpowers/specs/2026-07-02-ai-bookkeeping-mvp-design.md`. Each plan produces working,
tested software and is written to full TDD fidelity **when we reach it**, so it reflects the
interfaces the previous plans actually produced (rather than guessing them in advance).

| # | Plan | Status |
|---|------|--------|
| 1 | Foundation: tenancy, ledger core & audit | ✅ Done — merged to `main` (27 tests) |
| 2 | Parties, documents & the proposal/approval model | 📝 Written — ready to execute |
| 3 | AI/OCR document intake | ⏳ Roadmap below |
| 4 | VAT/tax engine + regulation-as-code | ⏳ Roadmap below |
| 5 | Banking (import + matching) | ⏳ Roadmap below |
| 6 | E-invoicing (Peppol) + VID reporting | ⏳ Roadmap below |
| 7 | Cabinet, roles & collaboration (web) | ⏳ Roadmap below |
| 8 | Mobile capture app | ⏳ Roadmap below |

Files: Plan 1 = `2026-07-02-foundation-tenancy-ledger-audit.md`; Plan 2 =
`2026-07-02-parties-documents-proposals.md`.

---

## Plan 3 — AI/OCR document intake

**Goal:** Turn an uploaded document into a validated, explainable draft posting-proposal.

**Depends on:** Plan 2 (documents, extraction versions, proposals, `postApprovedPosting`), Plan 1 (ledger).

**Likely tasks:**
1. **Blob storage adapter** — an interface `putObject/getObject` with a local-filesystem impl for dev/test and a pluggable cloud impl; documents' `storage_key` resolves through it. (Closes Plan 2's deferred blob boundary.)
2. **LLM extraction adapter** — an interface `extractDocument(bytes, mime) → {fields, confidence}` against a fixed zod schema (supplier, reg-no, date, currency, line items, VAT amounts/rates, totals); Claude vision impl behind it + a deterministic **stub** impl for tests. Zero-retention config.
3. **Deterministic validation** — code (not the LLM) checks totals reconcile, VAT math consistent, supplier resolves to a `party` (or flagged new), date/currency sane; low-confidence fields flagged. Pure, heavily unit-tested.
4. **Intake orchestration** — `received → extracting → recordExtraction → validate → draft posting proposal` (maps extracted fields to a `NewJournalEntry` payload + rationale), status `extracted`/`needs_review`.
5. **Autonomy policy** — `autonomy_policy` table (per client × operation type) + `resolveAutonomy()`; decides whether a drafted proposal is created `suggested`/auto-posted vs `pending_approval`. Guardrails: taxes/declarations/material-sum always `pending_approval`.
6. **Agent tool surface** — thin functions the agent calls (`draftFromDocument`, `listApprovalQueue`), all going through Plan 2 proposals (no privileged writes).

**Key open decisions:** exact extraction field schema; confidence thresholds; the Claude model + prompt for extraction; account-coding heuristic (rules vs LLM suggestion).

---

## Plan 4 — VAT/tax engine + regulation-as-code

**Goal:** Compute VAT and produce EDS-ready declarations from ledger data, explainably.

**Depends on:** Plan 1 (ledger/trial balance), Plan 2 (proposals — a `declaration` proposal type).

**Likely tasks:**
1. **Versioned rules store** — dated `tax_rules` (rates, thresholds) with an effective-date lookup; VAT rate as data, not code.
2. **VAT computation** — aggregate output/input VAT from journal lines for a period; monthly/quarterly by turnover; each figure carries {rule version, inputs} for explainability.
3. **Declaration assembly** — build the VAT declaration + annexes as a structured object; produce an EDS XML representation (adapter-backed).
4. **Declaration as a proposal** — declarations flow through the approval queue; **submission is always `pending_approval`** (human authority over state filings).
5. **Explainability queries** — "cik nodokļu šomēnes?" → number + drill-down to entries/rules.

**Key open decisions:** exact LR tax forms/norms (needs the practicing accountant, per spec §10); EDS submission mechanics; rule-versioning schema shape.

---

## Plan 5 — Banking (import + matching)

**Goal:** Import bank statements and propose payment↔invoice matches.

**Depends on:** Plan 1 (ledger), Plan 2 (proposals — `bank_match` type; parties).

**Likely tasks:**
1. **Statement parser** — camt.053 / ISO 20022 XML → normalized `bank_transactions` rows (adapter per bank format; Swedbank/SEB/Citadele to start; stub fixtures for tests).
2. **Import ingestion** — dedupe, store transactions, tenant-scoped, audited.
3. **Matching engine** — propose payment↔invoice/entry links with a confidence score → `bank_match` proposals through the approval queue.
4. **Confirm → post** — approving a match posts the settlement entry via the ledger and links the transaction.
5. **Payment orders** — generate SEPA payment files; debtor-balance view feeds reminders.

**Key open decisions:** confirmed bank list + exact statement formats (spec §10); matching heuristic.

---

## Plan 6 — E-invoicing (Peppol) + VID reporting

**Goal:** Send/receive EN 16931 structured invoices via an accredited Access Point and submit invoice data to VID within the 5-working-day window.

**Depends on:** Plan 1 (ledger), Plan 2 (documents, proposals), Plan 4 (tax context helpful).

**Likely tasks:**
1. **UBL/EN 16931 model + validation** — build/parse Peppol BIS Billing 3.0 (UBL 2.1); validate against EN 16931 rules **before** send.
2. **Access Point adapter** — send/receive via the accredited provider (interface + sandbox stub); delivery-status tracking.
3. **Outbound flow** — create invoice → render UBL → validate → dispatch → post receivable via ledger.
4. **Inbound flow** — Peppol XML → straight into Plan 2's extraction schema (skip OCR) → draft purchase proposal.
5. **VID submission + durable retry** — submit invoice data within 5 working days; **retry/dead-letter queue with alerting** so the legal window is a tracked obligation, not fire-and-forget.
6. **EDS declaration submission** — wire Plan 4's declarations to EDS with stored receipts.

**Key open decisions:** which accredited AP + its API; VID/EDS connection mechanics (spec §10); the durable-queue technology choice.

---

## Plan 7 — Cabinet, roles & collaboration (web)

**Goal:** The shared client↔accountant web workspace with role-scoped views and the approval queue UI.

**Depends on:** Plans 1–6 (surfaces their data); needs auth.

**Likely tasks:**
1. **Auth + roles** — email/password + mandatory 2FA; RBAC mapping to `TenantContext.actorRole`; per-client scoping enforced server-side.
2. **Next.js app shell** — role-aware navigation; LV/RU/EN i18n from the start.
3. **Approval queue UI** — the accountant's/owner's home: pending proposals with rationale + source drill-down, one-action approve/reject (calls Plan 2 lifecycle).
4. **Documents & upload UI** — upload, status, extracted-data review/correction.
5. **Collaboration** — tasks/requests ("missing contract"), comments on operations, notifications, audit-trail viewer.
6. **Financial views** — trial balance, VAT position, debtor balances, per role.

**Key open decisions:** auth provider (Clerk/Auth0/custom); UI framework specifics (shadcn/ui); notification transport.

---

## Plan 8 — Mobile capture app

**Goal:** React Native app for one-tap document capture + core client views.

**Depends on:** Plan 3 (intake/blob), Plan 7 (auth/API), Plan 2 (documents/proposals).

**Likely tasks:**
1. **Auth + API client** — reuse the web auth; tenant-scoped API.
2. **Capture** — camera → one-tap send, multi-doc sequence; upload to the blob adapter → `createDocument(source:'mobile')`.
3. **Offline queue** — persist captures locally, sync when connectivity returns.
4. **Client core views** — taxes, cash-flow snapshot, approvals (mobile approval queue), conversational assistant entry point.
5. **Notifications** — deadlines + agent questions awaiting approval; iOS + Android; LV/RU/EN.

**Key open decisions:** push-notification service; offline storage lib; how much of the assistant ships in MVP vs Phase 2.

---

## Cross-cutting conventions established (apply to every plan)

- **Migrations run as admin; runtime role `bookkeeping_app` owns nothing** and gets only `SELECT, INSERT` (+`UPDATE` where a documented op needs it), never `DELETE`/`TRUNCATE`, never `UPDATE` on append-only tables. Each new table migration ends with its own explicit `GRANT`.
- **Every tenant table:** `ENABLE` + `FORCE ROW LEVEL SECURITY` + tenant policy; every tenant-table read carries an explicit `client_company_id` predicate in addition to RLS.
- **Money is integer-cents / `NUMERIC`, never float.** Append-only where integrity matters (journal, audit, document versions), corrections via new rows.
- **Every state change goes through a domain API, lands in the audit log in the same transaction, and — for agent actions — is a `proposal` with immutable rationale.** The AI never has a privileged write path.
- **External systems (blob, LLM, Peppol AP, VID/EDS, banks) sit behind adapter interfaces with stub/sandbox impls**, so the core is testable without live services.

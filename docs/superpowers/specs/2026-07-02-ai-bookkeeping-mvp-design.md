# AI Bookkeeping Platform — MVP (Phase 1) Design

**Version:** 1.0
**Date:** 2026-07-02
**Status:** Approved for planning
**Source concept:** `Gramatvedibas_sistemas_koncepcija.docx` (v0.1, 2026-07)

---

## 1. Purpose & scope

We are building a cloud, AI-native bookkeeping platform for Latvian SMEs (primarily SIA),
comparable in functional scope to Horizon / 1C, but built around two differentiators competitors
lack: an **autonomous AI agent** ("does the work, asks for approval on material decisions, always
explains") and a **shared client↔accountant workspace** (the *personal cabinet*).

The strategic wedge is Latvia's mandatory structured e-invoicing: B2G from 2026-01-01, all domestic
B2B from 2028-01-01, with near-real-time data submission to VID (Peppol BIS Billing 3.0 / EN 16931).
Legacy systems are not adapted for this; a Peppol- and VID-native system holds an advantage through 2028.

This document specifies **Phase 1 (MVP) only**. It is deep enough to build directly. Later phases are
noted where the design leaves hooks for them, but are not designed here.

### Decisions fixed during brainstorming

| Decision | Choice |
|---|---|
| Deliverable | Detailed MVP design + light roadmap hooks |
| AI / OCR | External frontier LLM (Claude) via API, zero-retention DPA, EU processing where possible |
| Peppol / VID connectivity | Via an accredited Peppol Access Point + VID/EDS APIs (not a direct AP) |
| First user | Accountant-led, multi-client ("with services" model) |
| Tech stack | TypeScript full-stack (Next.js web + Node services), PostgreSQL ledger, React Native mobile |
| Architecture | Modular monolith with isolated domain core + async workers |

### MVP scope (in)

Ledger + Chart of Accounts, VAT engine (+ EDS declaration), banking import & matching, document
intake with AI/OCR, mobile capture, Peppol send/receive + VID submission, basic AI agent (draft
postings, bank matching, reminders, explainability), and the personal cabinet + collaboration layer.
Built for accountant-led, multi-client use.

### MVP scope (out — interfaces designed to attach later)

Payroll & HR, Fixed assets, Inventory/warehouse, annual report, full conversational assistant,
cash-flow forecast & anomaly detection, self-service (no-services) model, industry modules,
open API / marketplace.

---

## 2. Architecture

**Modular monolith with an isolated domain core + async workers.** One deployable TypeScript backend
organized into strict modules sharing one PostgreSQL database with a row-level multi-tenant boundary.
Heavy/slow work (OCR extraction, bank import, Peppol send/receive, VID submission) runs as async jobs
on a durable queue.

**Two invariants that make the product's promises real:**

1. **All state changes go through the Ledger's posting API and land in one append-only journal + audit
   log.** The accounting core is deterministic; the AI agent has no side-door.
2. **Every AI action is a proposal object with a lifecycle status** — `suggested → pending_approval →
   approved / rejected → posted` — carrying its rationale and source references. "Does the work but
   asks approval, always explains" is therefore a *data-model property*, not just UI behavior.

**Why not alternatives:** microservices-from-day-one is premature (distributed transactions across
ledger/tax/banking, ops overhead before the first client); an AI-orchestrator-first shape inverts
control in a domain where deterministic correctness and human authority are legally required. The
agent should *drive* the deterministic core, not *be* it.

### Modules

- **Ledger** (the heart) — Chart of Accounts, double-entry journal, periods, multi-currency/FX.
- **Parties & Documents** — customers/vendors (debtors/creditors), document store with extraction +
  versions + link to produced journal entry.
- **Tax/VAT engine** — VAT computation, declarations, built on versioned "regulation-as-code" rules.
- **Banking** — statement import (camt.053 / ISO 20022), payment↔invoice matching.
- **E-invoicing (Peppol) & VID reporting** — outbound/inbound structured invoices, VID submission, EDS.
- **Cabinet & Collaboration** — roles/permissions, tasks/requests, comments, notifications, audit trail.
- **Agent** — AI orchestration; holds no domain data; reads and proposes through the modules above.

---

## 3. Domain model

### Multi-tenancy

Two levels: an **Accounting Firm** (our org) owns many **Client Companies**. Every business row carries
`client_company_id` and is isolated by Postgres row-level security (RLS). Accountants are scoped to their
assigned clients; client users see only their own company. Tenant scoping is enforced server-side and
covered by cross-tenant access tests.

### Ledger (core entities)

- **Chart of Accounts** — Latvian default, configurable per client.
- **`journal_entries`** + **`journal_lines`** — double-entry; every entry balances (Σ debits = Σ credits).
- **Accounting periods** — with period close.
- **Multi-currency** — transaction currency + base currency, FX differences.
- **Append-only rule:** the journal is never edited. Corrections are *reversing entries*. This is what
  makes the audit trail trustworthy.
- **Posting API:** the only way to write GL rows. No module writes journal rows directly.

### Parties & Documents

- **Parties** — customers/vendors with reg-no, VAT-no, contact data; debtor/creditor balances derive
  from the ledger.
- **`documents`** — original file (blob storage) + extracted structured data + confidence + version
  history + link to the journal entry it produced + processing status.

### Proposal object (cross-cutting)

Every agent action is a **proposal** with: type (posting / bank-match / declaration / task),
status (`suggested | pending_approval | approved | rejected | posted`), the drafted payload, a
**rationale** (rule/norm reference + computation + source-data pointers), and links to source
documents/lines. Approval transitions call the relevant domain API; rejection captures the human
correction as a feedback signal.

---

## 4. AI agent & OCR document pipeline

### Document intake → posting

1. **Capture** — mobile photo (one tap, multi-doc, offline queue that syncs when online), web upload,
   email-in, or inbound Peppol XML. Document lands with status `received`.
2. **Extract** — async worker sends the document to the LLM vision/document capability (zero-retention)
   and receives **structured fields** against a fixed schema (supplier, reg-no, date, currency, line
   items, VAT amounts/rates, totals) with **per-field confidence** and source location. No templates;
   handles PDF / photo / scan in LV/RU/EN.
3. **Validate deterministically** — code (not the LLM) checks totals reconcile, VAT math is consistent,
   supplier resolves to a known party (or is flagged new), currency/date are sane. Low-confidence or
   failed-validation fields are flagged for human attention.
4. **Draft posting** — the agent proposes a `journal_entry` (account coding, VAT treatment) as a
   proposal object with rationale and links to the source document fields.
5. **Approve** — per autonomy config, either auto-post (low-risk, high-confidence, within thresholds) or
   route to the approval queue. On approval, post through the Ledger API; on reject, capture the correction.

### Agent design principles

- **Acts only through the same domain tools/APIs a human uses** (tool-calling): post entry, propose
  match, draft declaration, create task. No privileged writes.
- **Autonomy configurable per client × operation type**, from "suggest everything, human approves all"
  to "act, human handles exceptions." Stored as policy and **enforced server-side**, not in the prompt.
- **Explainability mandatory and structured** — every proposal stores {rule/norm reference,
  computation, source-data pointers}. Powers both the approval UI and conversational answers.
- **Guardrails (always `pending_approval` regardless of autonomy):** material-sum thresholds, unusual
  expense classification, anything touching taxes/declarations, anything filed with the state.
- **Other MVP agent jobs:** bank-statement matching proposals, deadline reminders (tax dates, unfinished
  tasks), and a basic LV/RU/EN assistant answering over the client's own data with citations.

### Bank matching

Reuses the proposal pattern: import statement → agent proposes payment↔invoice links with confidence →
accountant confirms exceptions.

---

## 5. E-invoicing, VID reporting & banking flows

### Outbound e-invoice (sales)

Create invoice → render as **Peppol BIS Billing 3.0 / UBL 2.1 (EN 16931-valid)** → validate against
EN 16931 rules *before* send → dispatch via the accredited **Access Point**; track delivery status.
The invoice posts a receivable through the Ledger API. Within **5 working days**, required invoice
data is submitted to **VID**; each submission's status/receipt is stored on the document. A
retry/dead-letter queue with alerting handles AP/VID outages so nothing silently misses the legal
window — near-real-time reporting is a *tracked* obligation, not fire-and-forget.

### Inbound e-invoice (purchase)

Peppol delivers structured XML → parsed straight into the extraction schema (skips OCR, higher
confidence) → agent drafts the purchase posting → approval → post.

### Declarations (EDS)

The Tax engine assembles VAT declarations + annexes (monthly/quarterly by turnover) as VID/EDS XML;
submission goes through EDS with stored receipts. Preparation is agent-automated; **submission is
always `pending_approval`** (human authority over state filings).

### Banking

Statement import via **camt.053 / ISO 20022** (Swedbank, SEB, Citadele to start) → agent proposes
payment↔invoice matches → confirm → post. Outbound payment orders generated as SEPA files;
debtor-balance tracking feeds reminders.

### Integration boundary

Peppol AP, VID, EDS, and each bank sit behind **adapter interfaces** with a stub/sandbox
implementation, so the accounting core is testable without live external systems and providers can be
swapped without touching domain code.

---

## 6. Cabinet, roles & collaboration

The **personal cabinet** is one shared workspace both client and firm accountant enter, with
role-separated views:

| Role | In the cabinet |
|---|---|
| Owner / entrepreneur | Financial position, tax & cash-flow view, approvals, uploads, asks the assistant |
| Client employee | Uploads documents, issues invoices, sees limited sections by permission |
| Firm accountant | Runs bookkeeping across many clients, controls the AI, approves complex operations, prepares reports |
| Firm administrator | Manages clients, tariffs, permissions, templates, settings |

**Collaboration layer** (shared by both business models, so built once in MVP): unified document store,
tasks/requests ("missing contract for this expense"), comments on operations, notifications (deadlines
+ agent questions awaiting approval), and full **audit trail**.

**Approval queue** — the accountant's and owner's home base: a single list of the agent's
`pending_approval` proposals (postings, matches, declarations), each showing rationale + source,
approvable in one action, mobile-friendly.

**Permissions** — role + per-client scoping enforced server-side (same boundary as RLS tenancy),
never merely hidden in the UI.

---

## 7. Security, compliance & non-functional requirements

- **Multi-tenant isolation** — Postgres RLS keyed on `client_company_id`; every query tenant-scoped;
  cross-tenant access assertions in the test suite.
- **Auth** — email + password with **mandatory 2FA**; role-based access control.
- **Audit** — append-only audit log over every human and agent action (who / what / when /
  before-after); immutable journal.
- **GDPR** — personal-data inventory, access/erasure handling, EU data residency for storage; LLM calls
  under zero-retention DPA; retention per LR requirements.
- **AI explainability** — non-functional guarantee: no proposal without stored rationale + source refs.
- **Regulation-as-code** — versioned, dated tax rules updated centrally without redeploying the core.
- **Reliability** — durable job queue with retries / dead-letter + alerting for legally-timed flows
  (VID 5-day window, declaration deadlines).
- **i18n** — LV/RU/EN across UI and documents from the start (data model carries language).
- **Scalability** — multi-tenant architecture, client data isolation.

---

## 8. Technology stack

- **Web:** Next.js (App Router) + TypeScript.
- **Backend:** Node/TypeScript modular monolith; module boundaries enforced by structure and lint rules.
- **Database:** PostgreSQL (ledger + all domain data), row-level security for tenancy.
- **Async work:** durable job queue (OCR extraction, bank import, Peppol/VID I/O) with retry/DLQ.
- **Mobile:** React Native (iOS + Android) — document capture, offline queue, client core views,
  notifications, approvals.
- **AI:** Claude via API (vision/document extraction + agent reasoning via tool-calling), zero-retention
  DPA, EU processing where available.
- **External adapters:** accredited Peppol Access Point, VID e-invoice API, EDS submission, bank
  statement formats — all behind swappable interfaces with stub/sandbox implementations.

---

## 9. Roadmap hooks (designed now, built later)

- Modules plug into the **Ledger posting API**, so Payroll / Fixed assets / Inventory add later without
  core changes.
- The **proposal / approval + explainability pattern** generalizes to every future agent capability.
- **Autonomy policy** is already per-operation-type, extensible to new operation types.
- **Adapter interfaces** already abstract external systems, so new banks/providers slot in.
- **i18n and regulation-as-code** are structural from day one, so new languages and rule changes don't
  require rework.

---

## 10. Open items to confirm before/within implementation

These are business/legal inputs the concept (section 10) flags; they do not block starting the
domain core but must be resolved before the corresponding integration ships:

- Precise list of LR tax norms, forms, and reports (with a practicing accountant / tax advisor).
- Specific accredited Peppol Access Point and VID/EDS API access mechanics.
- Confirmed bank list and exact statement formats for MVP.
- Material-sum thresholds and default autonomy policy for the first clients.

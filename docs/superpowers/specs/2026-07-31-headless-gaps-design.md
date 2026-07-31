# Design — closing the headless-backend gaps

Date: 2026-07-31. Scope: three defects that share one shape — backend shipped, no way for a
user to reach it. Two sit in M4 slice C-recurring, one in M9 (known-debt item 2).

No migration. `recurring_invoice_templates` (`migrations/043_recurring_invoices.sql`) and the
`proposals` type CHECK that admits `recurring_invoice` both already exist.

---

## Background: what is already shipped

`docs/ROADMAP-market-gaps.md` (M4 row) and `HANDOFF.md` both record C-recurring as
"scheduler now resolved, feature itself not started". That is stale. Shipped and tested:

- `src/recurring/recurring.ts` — template CRUD (`createTemplate`, `getTemplate`,
  `listTemplates`, `updateTemplate`, `deactivateTemplate`, `advanceSchedule`), zod-validated,
  EN 16931 payload probe, `appendAudit` on every mutation.
- `src/recurring/schedule.ts` — `clampToMonth`, `advanceRunDate`, `periodKey`,
  `buildRecurringInvoiceNumber`, `enqueueRecurringGenerate` (deduped on
  `recurring:<templateId>:<period>`).
- `src/recurring/generate.ts` — `generateDueRecurring`: skip-to-current billing, autonomy gate,
  end conditions, schedule advance in the same transaction as the issue.
- `src/recurring/reap.ts` — chain reaper.
- `src/jobs/register.ts` — the `recurring_generate` handler, self-perpetuating while active.
- `web/app/api/recurring/route.ts` + `web/app/api/recurring/[id]/route.ts` — GET/POST and
  PATCH/DELETE, role-gated on `einvoice.issue`.
- `tests/recurring/` — six test files.

What is missing is everything between that engine and a human.

---

## The three defects

| | Defect | Layer |
|---|---|---|
| A2 | Approving a `recurring_invoice` proposal issues nothing; the occurrence is silently lost | correctness |
| A1 | No UI to create, list, or pause a template | UI |
| B | No path to a prepared filing's XML or approved state; `RationaleBlock` drops object-valued `sourceRefs` | UI + shared component |

### A2 is the default path, not an edge case

`src/api/handlers.ts:52-54` dispatches approved proposals by type:

```ts
if (prop.type === 'posting') return postApprovedPosting(tx, ctx, id);
if (prop.type === 'bank_match') return postApprovedBankMatch(tx, ctx, id);
return { entryId: null }; // declaration/task: approval only, no ledger post here
```

`generateDueRecurring` gates on autonomy: `auto` calls `sendInvoice` inline; anything else
creates a `pending_approval` proposal of type `recurring_invoice`. That proposal falls through
the dispatch above and returns `{ entryId: null }`. No receivable is posted, no UBL is built,
nothing reaches the Access Point.

`resolveAutonomy` (`src/autonomy/autonomy.ts:39`) is **default-closed** — with no
`autonomy_policy` row it returns `'approval'`. A client must explicitly set an `auto` policy for
`recurring_invoice`, and stay under the materiality threshold, to reach the working branch. The
broken path is therefore what every client gets out of the box.

The loss is silent because `advanceSchedule` has already committed in the same transaction that
created the proposal: `next_run_date` has moved on, so the missed occurrence is never retried.

The trailing comment is also wrong — it names `declaration/task` but the fallthrough now also
catches `ecsl` and `recurring_invoice`.

---

## A2 — approval dispatch

### Two seams first

`src/api/handlers.ts` lives in `src/` and is shared by the web and mobile API surfaces, so it
cannot import from `web/app/lib/`. Issuing an invoice needs an `AccessPoint` and the outbound
account codes; both currently live only on the web side or inline in the job registry.

**`src/einvoice/access-point-factory.ts`** — `getAccessPoint(): AccessPoint`, a module-level
singleton returning `StubAccessPoint` today. Mirrors the established `makeBlobStore()` pattern in
`src/blob/factory.ts`. Three independent `new StubAccessPoint()` instances exist today
(`web/app/lib/access-point.ts`, `src/jobs/register.ts`'s `recurringAccessPoint`, and per-test
construction); they converge on this factory so the real Access Point lands in one place when
`HANDOFF.md` #1 ships. Singleton rather than new-per-call preserves today's semantics: a real
Access Point will hold a connection and certificate, and one instance per process is correct.
`StubAccessPoint.receive()` has no production caller (`src/einvoice/inbound.ts:72` takes `ap` as
an argument and nothing in `web/` wires it), so the change is behaviour-preserving.

**`src/einvoice/accounts.ts`** — `outboundInvoiceAccounts()` returning the
`EINVOICE_RECEIVABLE_ACCOUNT` / `EINVOICE_SALES_ACCOUNT` / `EINVOICE_VAT_ACCOUNT` env-or-default
triple (`2310` / `6110` / `5721`), currently copy-pasted in `web/app/api/einvoices/route.ts:15-17`
and `src/jobs/register.ts:25-29`. The approve path would have been a third copy; instead all three
read one function. This does not resolve the per-client account-mapping debt (§M2 follow-ups in
`HANDOFF.md`) — it consolidates it.

### The post function

**`src/recurring/post-approved.ts`** → `postApprovedRecurringInvoice(tx, ctx, id)`. Placed in the
owning module to match the existing convention: `postApprovedPosting` lives in
`src/proposals/post-proposal.ts`, `postApprovedBankMatch` in `src/banking/confirm-match.ts`.

It reads the proposal payload — `{ invoice, recipientPeppolId, customerPartyId, dueDate }`,
exactly what `generateDueRecurring` writes — and calls `sendInvoice` with the factory Access Point
and the shared accounts, returning the entry id so `resolved_entry_id` is recorded like the other
two post paths.

### Dispatch

```ts
if (prop.type === 'recurring_invoice') return postApprovedRecurringInvoice(tx, ctx, id);
```

The fallthrough comment is corrected to name `declaration`, `ecsl`, and `task` as the deliberate
approval-only types. `declaration` and `ecsl` terminating at approval is by design — see
`HANDOFF.md` M9 known-debt item 1; a filing must never auto-submit.

---

## A1 — template UI

### Composer: a third mode on `/invoices/new`

`web/app/(cabinet)/invoices/new/page.tsx` already carries a `docType` select
(`'invoice' | 'credit_note'`, line 48). It gains `'recurring'`.

In recurring mode the invoice-number and issue-date inputs are replaced by cadence fields —
anchor day (1–31), interval months, first run date, and the optional payment-terms days, end date,
and occurrence count — and the submit button POSTs `/api/recurring` instead of `/api/einvoices`.

Everything else is shared across all three modes unchanged: the customer picker, the Peppol-ID
derivation (`0088:${customer.regNo}`, line 109 — the template requires `recipientPeppolId` because
`parties` stores no Peppol endpoint), the line editor, VAT auto-compute, and live totals. The
template payload is precisely `EInvoice` minus `invoiceNumber`/`issueDate`/`dueDate`, so the
mapping is direct.

The composer surfaces the autonomy consequence — whether invoices from this template will be
issued automatically or held for approval — because it is non-obvious and default-closed, and it
determines whether the accountant should expect items in the approval queue each period.

### List: a tab on `/invoices`

`web/app/(cabinet)/invoices/page.tsx` is a single flat outbox table with no tabs. It gains the
`role="tablist"` pattern already used on `/reports` and `/filings`, with the existing outbox as the
default tab.

The Recurring tab lists customer, cadence, next run date, and active state, ordered by next run
date (`listTemplates` already sorts that way). Row actions: pause (`DELETE`, which deactivates
rather than deletes) and edit (`PATCH`).

---

## B — filings XML and the rationale panel

**`GET /api/filings/[proposalId]`** returns the filing proposal's status and its stored `xml`,
with `Content-Disposition: attachment` when `?download=1`.

`/filings` looks the filing up **by period** on load. Today the page holds `body.proposalId` in
ephemeral React state after a prepare POST (`filings/page.tsx:226`), so a reload forgets that a
filing was ever prepared — threading the POST response through is not sufficient. With the lookup
in place the page renders the prepared/approved indicator and the download button, wiring the two
i18n keys `filings.downloadXml` and `filings.approved` that were added in the M9 wave and have sat
unused since.

**`RationaleBlock`** (`web/app/components/RationaleBlock.tsx`): `humanizeSourceRefs` currently
`continue`s on any object-valued entry, which is why the ECSL approval card's sources section
renders empty rather than showing its period. It gains a shallow one-level flatten, so
`period.fromDate` becomes a labelled row; deeper nesting stays dropped as before.

The `xml` key deliberately stays out of `RationaleBlock`. It belongs behind the download, not
inside a panel designed for human-readable rationale — and `RationaleBlock` is shared by every
proposal type, so a raw XML blob there would affect all of them.

---

## Edge semantics

These are deliberate choices, recorded so they are not later read as oversights.

**Reject skips the period permanently.** When a `recurring_invoice` proposal is rejected, the
template's `next_run_date` has already advanced. Rolling it back would re-bill the same occurrence
on every subsequent tick — an infinite retry loop on a template the accountant has judged wrong.
Skip-and-record is correct: reject means "do not bill this period."

**A failed issue rolls back the approval.** `approveProposal` and the post function run inside one
`withTenant` transaction, so a `sendInvoice` failure — closed period, EN 16931 violation, missing
account — rolls back the status transition too. The proposal stays `pending_approval` and remains
retryable rather than being stranded in `approved` with nothing issued.

**Double-approve is already guarded.** `transition()` in `src/proposals/lifecycle.ts:11-13` throws
unless the current status is exactly `pending_approval`, so a repeated approve cannot double-send.

**Invoice numbers stay deterministic.** `buildRecurringInvoiceNumber` yields
`PREFIX-YYYY-MM-<first 8 of templateId>`. Combined with the job dedup key and the single-transaction
advance, one period bills once. Note that `einvoices.invoice_number` still has no uniqueness
constraint (M9 known-debt item 6) — unchanged by this work.

---

## Testing

- `tests/recurring/post-approved.test.ts` — approval issues the invoice, posts the receivable, and
  records the Peppol message id; reject leaves no einvoice behind; double-approve throws; a
  `sendInvoice` failure rolls the approval back to `pending_approval`.
- `tests/api/` — the approve route returns an entry id for a `recurring_invoice` proposal rather
  than the null it returns today.
- The six existing `tests/recurring/*` files stay green, and `tests/einvoice/*` covers the
  Access-Point and accounts consolidation for regressions.
- `npm test` at the repo root, and `npx tsc --noEmit` in both root and `web/`.
- A browser walk of both surfaces. M9 known-debt item 8 records that the previous wave's
  interactive walk was deferred to the controller and never performed; this one is performed.

Per `MEMORY.md`, suites run one at a time — `resetDb` drops the schema, so concurrent vitest runs
against the shared database collide.

---

## Out of scope

Quotes→invoice and customer statements (M4 slice D), the per-client account-mapping settings
screen, VIES validation of VAT numbers, Intrastat, and the real Peppol Access Point
(`HANDOFF.md` #1).

## Documentation to correct

`docs/ROADMAP-market-gaps.md` (M4 row) and `HANDOFF.md` both describe C-recurring as not started.
Both are updated as part of this work to record what shipped and what this wave adds.

# M6 Expense Claims Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Employee self-service expense claims: receipt + mileage lines → approval queue → posted expense (DR expense / DR deductible VAT / CR 5610) → bank reimbursement (pain.001 + settlement).

**Architecture:** New `src/expenses/` module mirroring the bills machinery: proposal-gated posting through the existing approval queue, payables-style settlement, one new migration. Employee self-scope via a new `employees.user_id` link.

**Tech Stack:** TypeScript, Postgres 16 (RLS), Next.js 16 (`web/`), vitest, zod.

**Spec:** `docs/superpowers/specs/2026-07-20-expense-claims-design.md` — read it first; its decisions bind every task.

## Global Constraints

- Branch: `expense-claims` off `main` (Task 1 creates it).
- **Division of labor:** implementers run ONLY their focused test file(s) (`npx vitest run tests/expenses/<file>`) plus `npx tsc --noEmit` (root, and web when web/ changed). Implementers do NOT run the full `npm test` and do NOT commit — the controller runs the full suite (shared DB, one run at a time; subagent background runs die in this environment) and commits after each task.
- TDD on every domain task: failing test first, RED evidence, then implement, GREEN evidence — both in the task report.
- Money is integer cents (`bigint` / `BigInt`, `src/db/money.ts` helpers `toCents`/`fromCents`/`sumCents`). Never floats — mileage math uses the BigInt helper defined in Task 2.
- Every mutation inside `withTenant` + `appendAudit(...)`. RLS ENABLE+FORCE + tenant policy + grants on every new table.
- i18n: every user-facing string in all three catalogs (LV/RU/EN) in `web/app/lib/i18n.ts` (typed record fails web tsc on a miss).
- API routes copy the standard pattern: `getSessionToken()` → `resolveTenantContext(token, clientCompanyId, nowUnix())` → `assertRoleAllowed` → domain call in `withTenant` → `errorToStatus` mapping. `export const runtime = 'nodejs'`.
- Migration number is `043` (current max is `042`); never reuse a number.
- Account constants in routes, env-overridable: `EXPENSE_SETTLEMENT_ACCOUNT` ?? `'5610'`, `EXPENSE_VAT_INPUT_ACCOUNT` ?? `'5722'`, `BANK_ACCOUNT` ?? `'2620'` (same idiom as `web/app/api/bills/route.ts`).
- Commit messages end with: `Claude-Session: https://claude.ai/code/session_01KSc2FBU6R8j58wcNaikqwB`

---

### Task 1: Migration 043 + schema/RLS tests

**Files:**
- Create: `migrations/043_expense_claims.sql`
- Test: `tests/expenses/schema.test.ts`

**Interfaces:**
- Produces: tables `expense_claims`, `expense_claim_lines`, `expense_settings`; columns `employees.user_id`, `employees.iban`; documents source value `'expense'`. All later tasks consume these.

- [ ] **Step 1: Write the failing schema test** (mirror `tests/jobs/schema.test.ts` + the RLS test idiom in `tests/tenancy/rls.test.ts`)

```ts
// tests/expenses/schema.test.ts — asserts, against a migrated DB:
// 1. expense_claims / expense_claim_lines / expense_settings exist with RLS forced
//    (SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ...).
// 2. employees has user_id (nullable uuid) and iban (nullable text) columns;
//    expense_claims has reimbursement_bank_transaction_id with its partial unique index.
// 3. documents source CHECK accepts 'expense' (INSERT a documents row with source 'expense' succeeds)
//    and still rejects garbage (INSERT source 'nonsense' throws).
// 4. expense_claims status CHECK rejects 'bogus'.
// 5. Tenant isolation: a claim inserted for client A is invisible under client B's
//    app.current_client_id (copy the two-client fixture from tests/tenancy/rls.test.ts).
```

- [ ] **Step 2: Run it to verify failure**

Run: `npx vitest run tests/expenses/schema.test.ts` → FAIL (relations do not exist).

- [ ] **Step 3: Write the migration**

```sql
-- Expense claims (M6): employee self-service claims -> approval queue -> bank reimbursement.
-- The employee is the payee; claims mirror bills (proposal-gated posting, payables-style settlement).

-- Self-service link + payout target.
ALTER TABLE employees ADD COLUMN user_id uuid REFERENCES users(id);
ALTER TABLE employees ADD COLUMN iban text;
CREATE UNIQUE INDEX employees_user_link_uidx
  ON employees(client_company_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE expense_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','submitted','approved','reimbursed','rejected')),
  description text NOT NULL DEFAULT '',
  currency char(3) NOT NULL DEFAULT 'EUR',
  total_net_cents bigint NOT NULL DEFAULT 0,
  total_vat_cents bigint NOT NULL DEFAULT 0,
  total_cents bigint NOT NULL DEFAULT 0,
  posting_proposal_id uuid REFERENCES proposals(id),
  journal_entry_id uuid REFERENCES journal_entries(id),
  reimbursed_at timestamptz,
  reimbursement_entry_id uuid REFERENCES journal_entries(id),
  reimbursement_bank_transaction_id uuid REFERENCES bank_transactions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One claim per settling bank transaction (mirror of invoice_payments' dedup).
CREATE UNIQUE INDEX expense_claims_reimb_txn_uidx
  ON expense_claims(reimbursement_bank_transaction_id)
  WHERE reimbursement_bank_transaction_id IS NOT NULL;
CREATE INDEX expense_claims_client_status_idx ON expense_claims(client_company_id, status, created_at);

CREATE TABLE expense_claim_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  claim_id uuid NOT NULL REFERENCES expense_claims(id) ON DELETE CASCADE,
  line_no int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt','mileage')),
  line_date date NOT NULL,
  description text NOT NULL,
  expense_account text NOT NULL,
  net_cents bigint NOT NULL CHECK (net_cents >= 0),
  vat_cents bigint NOT NULL DEFAULT 0 CHECK (vat_cents >= 0),
  vat_deductible boolean NOT NULL DEFAULT false,
  document_id uuid REFERENCES documents(id),
  km numeric(8,1),
  rate_cents bigint
);
CREATE INDEX expense_claim_lines_claim_idx ON expense_claim_lines(claim_id);

CREATE TABLE expense_settings (
  client_company_id uuid PRIMARY KEY REFERENCES client_companies(id),
  mileage_rate_cents_per_km bigint NOT NULL DEFAULT 30
);

-- Receipt photos uploaded for a claim line bypass the intake pipeline.
ALTER TABLE documents DROP CONSTRAINT documents_source_check;
ALTER TABLE documents ADD CONSTRAINT documents_source_check
  CHECK (source IN ('mobile','web','email','peppol','expense'));

ALTER TABLE expense_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_claims_tenant_isolation ON expense_claims
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
ALTER TABLE expense_claim_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_claim_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_claim_lines_tenant_isolation ON expense_claim_lines
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
ALTER TABLE expense_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE expense_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY expense_settings_tenant_isolation ON expense_settings
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON expense_claims TO bookkeeping_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON expense_claim_lines TO bookkeeping_app;
GRANT SELECT, INSERT, UPDATE ON expense_settings TO bookkeeping_app;
```

(DELETE grant on claims/lines: draft deletion + wholesale line replacement. If `documents_source_check` is named differently, find it via `SELECT conname FROM pg_constraint WHERE conrelid = 'documents'::regclass AND contype='c';`.)

- [ ] **Step 4: Apply + test green**

Run: `npm run migrate` (applies 043), then `npx vitest run tests/expenses/schema.test.ts` → PASS. Also `npx vitest run tests/db/migration-numbering.test.ts` → PASS.

- [ ] **Step 5: Report** (controller runs full suite + commits).

---

### Task 2: Claims + settings domain (CRUD, totals, mileage math, self-scope)

**Files:**
- Create: `src/expenses/claims.ts`, `src/expenses/settings.ts`, `src/expenses/scope.ts`
- Test: `tests/expenses/claims.test.ts`, `tests/expenses/settings.test.ts`, shared fixtures in `tests/expenses/helpers.ts`

**Interfaces:**
- Consumes: Task 1 tables; `TenantContext` (`ctx.actorId` = user id, `ctx.actorRole`).
- Produces (used by Tasks 3–8):

```ts
// scope.ts
/** Resolve the employee the actor may write claims for. Client-side roles
 * (employee, owner) must be linked via employees.user_id = ctx.actorId and may
 * only act as themselves; firm roles pass any employeeId through. Throws
 * "Not linked to an employee" / "Forbidden: not your claim" style errors. */
export async function resolveClaimEmployee(tx, ctx, requestedEmployeeId: string | null): Promise<string /* employeeId */>;
export function canSeeAllClaims(role: string): boolean; // firm_admin | accountant | owner

// claims.ts
export interface NewClaimLine { kind: 'receipt' | 'mileage'; lineDate: string; description: string;
  expenseAccount: string; net?: string; vat?: string; vatDeductible?: boolean;
  documentId?: string | null; km?: string; }
export interface ClaimRow { id: string; employeeId: string; employeeName: string; status: string;
  description: string; currency: string; totalNetCents: string; totalVatCents: string; totalCents: string;
  postingProposalId: string | null; journalEntryId: string | null; createdAt: string; }
export interface ClaimDetail extends ClaimRow { lines: {...ClaimLine fields, netCents/vatCents/rateCents as strings}[] }
export async function saveClaim(tx, ctx, input: { claimId?: string; employeeId?: string | null;
  description: string; lines: NewClaimLine[] }): Promise<{ claimId: string }>; // create or replace-lines update; drafts only
export async function getClaim(tx, ctx, id): Promise<ClaimDetail>;   // employee role: own only
export async function listClaims(tx, ctx, filter: { status?: string }): Promise<ClaimRow[]>; // employee role: own only
export async function deleteDraft(tx, ctx, id): Promise<void>;
export function mileageNetCents(km: string, rateCents: bigint): bigint; // BigInt, round half-up

// settings.ts
export async function getExpenseSettings(tx, ctx): Promise<{ mileageRateCentsPerKm: string }>; // default-row-on-read
export async function setMileageRate(tx, ctx, rateCents: string): Promise<void>; // audited, > 0
```

- [ ] **Step 1: Write failing tests.** Fixtures in `helpers.ts`: firm + client + accountant ctx + two employees (A linked to user uA, B linked to uB) — copy the firm/client/user creation idiom from `tests/receivables/helpers.ts` and employee creation from `tests/payroll/employees.test.ts`. Cases:

```ts
// claims.test.ts
it('creates a draft with receipt + mileage lines and computes totals server-side', ...);
//   receipt: net '10.00' vat '2.10' deductible → line 1000/210
//   mileage: km '12.5', rate 30 → mileageNetCents = round(12.5 × 30) = 375, vat 0
//   claim totals: net 1375, vat 210, gross 1585 — assert DB row cents exactly
it('mileage rounds half-up on the km fraction', ...); // km '0.5' rate 25 → 12.5 → 13
it('update replaces lines wholesale and recomputes totals; only drafts are editable', ...);
//   updating a submitted claim throws
it('employee ctx may only save/get/list their own claims', ...);
//   ctx with actorRole 'employee', actorId uA: saveClaim(employeeId: B) throws;
//   getClaim(claimOfB) throws; listClaims returns only A's
it('owner ctx writes self-scoped but lists all claims', ...);
it('accountant saves a claim for any employee', ...);
it('unlinked employee user gets a clear "not linked" error', ...);
it('deleteDraft removes claim + lines; refuses non-drafts', ...);
// settings.test.ts
it('getExpenseSettings creates the default row (30) on first read', ...);
it('setMileageRate updates, audits, rejects zero/negative', ...);
```

- [ ] **Step 2: RED** — `npx vitest run tests/expenses/claims.test.ts tests/expenses/settings.test.ts` fails (module not found).

- [ ] **Step 3: Implement.** Key code:

```ts
// mileage: km numeric(8,1) arrives as string like '12.5'
export function mileageNetCents(km: string, rateCents: bigint): bigint {
  if (!/^\d+(\.\d)?$/.test(km)) throw new Error(`km must be a non-negative number with at most 1 decimal (got ${km})`);
  const [whole, frac = '0'] = km.split('.');
  const km10 = BigInt(whole) * 10n + BigInt(frac); // km × 10, exact
  const num = km10 * rateCents;                    // cents × 10
  return (num + 5n) / 10n;                         // round half-up
}
```

`saveClaim`: zod-validate lines (receipt requires `net`; mileage requires `km`, forbids net/vat/vatDeductible=true), resolve employee via `resolveClaimEmployee`, snapshot the current mileage rate into `rate_cents` per mileage line, DELETE+INSERT lines, UPDATE totals, `appendAudit`. Currency fixed `'EUR'` v1. Zod idiom + `toCents` per `src/payables/bills.ts`.

- [ ] **Step 4: GREEN** — both test files pass. `npx tsc --noEmit` clean.
- [ ] **Step 5: Report** (controller runs full suite + commits).

---

### Task 3: Submit → proposal; approval posts; reject returns to draft

**Files:**
- Create: `src/expenses/submit.ts`
- Modify: `src/proposals/post-proposal.ts` (one UPDATE block), `src/proposals/lifecycle.ts` (one block in `rejectProposal`)
- Test: `tests/expenses/lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 2 (`getClaim`), `createProposal` (`src/proposals/proposals.ts`), `approveProposal`/`rejectProposal`, `postApprovedPosting`.
- Produces: `submitClaim(tx, ctx, claimId, accounts: { settlementAccount: string; vatInputAccount: string }): Promise<{ proposalId: string }>`; `buildClaimEntry(detail: ClaimDetail, accounts): NewJournalEntry`.

- [ ] **Step 1: Failing tests**

```ts
it('submitClaim flips draft→submitted and creates a pending posting proposal with entry payload + rationale', ...);
//   payload IS the NewJournalEntry (postApprovedPosting posts prop.payload directly — same as bills);
//   assert proposal.type 'posting', status 'pending_approval', rationale mentions employee name + total
it('approving + posting the proposal posts the exact entry and flips the claim to approved', ...);
//   claim: receipt 10.00+2.10 deductible, receipt 5.00+1.05 NON-deductible, mileage 3.75
//   entry lines: DR 7550(example acct) 10.00 · DR 7550 6.05 (non-deductible line books GROSS to expense)
//                · DR 7XXX 3.75 · DR 5722 2.10 · CR 5610 21.90
//   assert via listJournalEntries/DB; claim.journal_entry_id set, status 'approved'
it('rejecting the proposal returns the claim to draft and clears posting_proposal_id', ...);
it('submitClaim refuses empty and zero-total claims, and non-drafts', ...);
```

**Posting rule (from spec):** deductible lines post net to expense + their VAT to 5722; NON-deductible lines post **gross** (net+vat) to the expense account; CR 5610 for the claim's gross total. `buildClaimEntry` mirrors `buildBillEntry`'s shape (`src/payables/bills.ts:62-70`).

- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement.**

`submitClaim`: load detail (scope-checked — the submitter must be the claim's employee for client-side roles), guard status/lines/total, `createProposal(tx, ctx, { type: 'posting', payload: buildClaimEntry(...), rationale, documentId: null })` then `submitForApproval` if createProposal starts at 'suggested' (copy exactly what `createBill` does), UPDATE claim `status='submitted', posting_proposal_id=$id`, audit.

`post-proposal.ts` — after the vendor_credit_notes block, add:

```ts
// Link + approve an expense claim, if this posting proposal originated from one.
await tx.query(
  `UPDATE expense_claims SET journal_entry_id = $1, status = 'approved'
   WHERE posting_proposal_id = $2 AND client_company_id = $3 AND status = 'submitted'`,
  [entryId, proposalId, ctx.clientCompanyId],
);
```

`lifecycle.ts` `rejectProposal` — after the bank_match block:

```ts
// A rejected claim proposal sends the claim back to draft for correction.
if (prop.type === 'posting') {
  await tx.query(
    `UPDATE expense_claims SET status = 'draft', posting_proposal_id = NULL
     WHERE posting_proposal_id = $1 AND client_company_id = $2 AND status = 'submitted'`,
    [id, ctx.clientCompanyId],
  );
}
```

- [ ] **Step 4: GREEN** + root tsc. Also run `npx vitest run tests/payables/bill-approval.test.ts tests/proposals/lifecycle.test.ts` (you touched their code paths).
- [ ] **Step 5: Report** (controller: full suite + commit).

---

### Task 4: Reimbursement — manual settlement + pain.001 payment order

**Files:**
- Create: `src/expenses/reimburse.ts`
- Test: `tests/expenses/reimburse.test.ts`

**Interfaces:**
- Consumes: `generateSepaCreditTransfer(payments: {iban, amount, reference}[])` (`src/banking/sepa.ts`), `postEntry`, Task 2/3 state machine.
- Produces (Task 5 + routes consume):

```ts
export async function settleClaim(tx, ctx, args: { claimId: string; paidDate: string;
  method: 'manual' | 'bank_match'; bankTransactionId?: string | null;
  bankAccount: string; settlementAccount: string }): Promise<{ entryId: string }>;
export async function buildReimbursementOrder(tx, ctx, claimIds: string[]):
  Promise<{ xml: string; total: string }>;
```

- [ ] **Step 1: Failing tests**

```ts
it('settleClaim posts DR 5610 / CR 2620 for the gross total and flips approved→reimbursed', ...);
it('settleClaim refuses non-approved claims and double settlement', ...);
it('a bank transaction may settle at most one claim (dedup guard)', ...);
//   mirror settleReceivable's guard: same bankTransactionId twice → second throws
it('buildReimbursementOrder emits pain.001 with the employee IBAN, amount, claim reference', ...);
//   assert xml contains <IBAN>, InstdAmt with fromCents(total), reference with claim id/description
it('buildReimbursementOrder throws a clear error when an employee lacks an IBAN', ...);
```

- [ ] **Step 2: RED.**  **Step 3: Implement.** `settleClaim` mirrors `src/receivables/settlement.ts`: status guard (`approved` only — v1 settles a claim exactly once and whole), post DR settlementAccount / CR bankAccount... careful: reimbursement PAYS OUT — **DR 5610 (clears the liability) / CR 2620 (bank)**; set `reimbursement_entry_id`, `reimbursed_at = now()`, `reimbursement_bank_transaction_id` (column + partial unique index exist from Task 1 — the dedup guard: check `SELECT 1 FROM expense_claims WHERE reimbursement_bank_transaction_id = $1` before settling, and the unique index backstops races), status → `'reimbursed'`, `appendAudit`. `buildReimbursementOrder`: load approved claims + their employees' IBANs, error listing employees without an IBAN, `generateSepaCreditTransfer` with `fromCents(total_cents)` amounts and `Expense claim <id-prefix> — <description>` references.
- [ ] **Step 4: GREEN** + tsc. **Step 5: Report.**

---

### Task 5: Bank-debit auto-matching (`expense_direct`)

**Files:**
- Modify: `src/banking/match.ts` (add `proposeExpenseMatches`), `src/banking/confirm-match.ts` (add the `expense_direct` branch), `web/app/api/bank/import/route.ts` + `src/bankfeed/sync.ts` (call the new proposer alongside AR/AP)
- Test: `tests/expenses/bank-match.test.ts`

**Interfaces:**
- Consumes: the matcher family idiom (`proposeApMatches`/`proposeArMatches` in `src/banking/match.ts` — read both first), `settleClaim` (Task 4).
- Produces: `proposeExpenseMatches(tx, ctx, config: { bankAccount: string; settlementAccount: string }): Promise<{ proposalIds: string[] }>` — debit transactions exactly matching one approved claim's gross total → `bank_match` proposal (payload `{ kind: 'expense_direct', bankTransactionId, claimId, amountCents }`); confirm branch calls `settleClaim(method 'bank_match')`.

- [ ] **Step 1: Failing tests**

```ts
it('a debit equal to one approved claim proposes an expense_direct match', ...);
it('no proposal when amounts differ or claim not approved', ...);
it('two equal debits cannot both claim one claim (propose-time dedup)', ...);
it('confirming an approved expense_direct match settles the claim and reconciles the txn', ...);
it('rejecting an expense_direct match frees the bank transaction (generic reject path)', ...);
```

- [ ] **Step 2: RED.** **Step 3: Implement** mirroring the `payable_direct` proposer + confirm branch (both files show the exact idiom — propose-time dedup subquery, `cleared/settled` guards). The generic `rejectProposal` bank_match block already frees any payload carrying `bankTransactionId` — the payload must carry it.
- [ ] **Step 4: GREEN**; also `npx vitest run tests/banking/match.test.ts tests/banking/confirm-match.test.ts tests/banking/reject-frees-transaction.test.ts tests/bankfeed/sync.test.ts` (touched paths). tsc root + web.
- [ ] **Step 5: Report.**

---

### Task 6: Authz ops + API routes (incl. receipt upload with prefill)

**Files:**
- Modify: `src/authz/policy.ts`, `tests/authz/policy.test.ts`
- Create: `web/app/api/expenses/route.ts` (GET list / POST save), `web/app/api/expenses/[id]/route.ts` (POST submit|settle|delete via `action`), `web/app/api/expenses/payment-order/route.ts`, `web/app/api/expenses/settings/route.ts` (GET/PUT), `web/app/api/expenses/upload/route.ts`
- Test: authz rows in `tests/authz/policy.test.ts`; upload domain logic test `tests/expenses/upload.test.ts` if you extract a domain helper (see Step 3)

**Interfaces:**
- Consumes: all Task 2–4 exports; `makeBlobStore()` (`src/blob/factory.ts`); the documents INSERT + extractor idiom from `src/api/capture-handler.ts` (read it first); `assertRoleAllowed`, `errorToStatus`.
- Produces ops: `'expenses.write'` `['firm_admin','accountant','owner','employee']` · `'expenses.reimburse'` `['firm_admin','accountant']` · `'expenses.settings.write'` `['firm_admin','accountant']`.

- [ ] **Step 1: Failing authz test** (extend the existing matrix test + MATRIX record):

```ts
it('expense ops: write is all-roles (self-scoped in domain), reimburse/settings are firm-side', () => {
  expect(isRoleAllowed('employee', 'expenses.write')).toBe(true);
  expect(isRoleAllowed('owner', 'expenses.write')).toBe(true);
  for (const op of ['expenses.reimburse', 'expenses.settings.write'] as const) {
    expect(isRoleAllowed('accountant', op)).toBe(true);
    expect(isRoleAllowed('firm_admin', op)).toBe(true);
    expect(isRoleAllowed('owner', op)).toBe(false);
    expect(isRoleAllowed('employee', op)).toBe(false);
  }
});
```

- [ ] **Step 2: RED (TS error)** → add the three ops + matrix rows → GREEN (`npx vitest run tests/authz/policy.test.ts`).
- [ ] **Step 3: Routes.** Copy `web/app/api/bills/route.ts` / `web/app/api/receivables/[id]/route.ts` patterns; account constants per Global Constraints; validate `paidDate` with `isValidIsoDate`. Upload route: extract the storable logic into `src/expenses/upload.ts` — `storeExpenseReceipt(tx, ctx, { bytes, mimeType, filename, blobStore, extractor }): Promise<{ documentId, suggestion }>` — INSERT documents row (source `'expense'`, status `'received'`, blob key from the store) with **no proposal**, run the extractor once (Stub-safe), map its fields to `{ amount?, date?, merchant? }`. Route wires `makeBlobStore()` + the same extractor factory capture uses. Test `storeExpenseReceipt` with the stub extractor + local blob store: document row exists, `SELECT count(*) FROM proposals` unchanged, suggestion shape returned.
- [ ] **Step 4:** tsc root + web clean; focused tests green. **Step 5: Report.**

---

### Task 7: Employee card — user link + IBAN fields

**Files:**
- Modify: the payroll employees domain (`src/payroll/employees.ts` — add `userId`/`iban` to the employee shape, create/update, zod) and its API route + `/payroll` employees UI page (find via `grep -rn "employees" web/app/api/payroll web/app/\(cabinet\)/payroll`), `web/app/lib/i18n.ts`
- Test: extend `tests/payroll/employees.test.ts`

**Interfaces:**
- Consumes: existing employee CRUD; users list for the picker (`listUsersForFirm` — see `tests/collab/cabinet-gaps.test.ts`) filtered client-side to client-side roles.
- Produces: employees carry `userId`/`iban` end-to-end (Tasks 2/4 read them).

- [ ] **Step 1: Failing test:** create/update an employee with `userId` + `iban`, read both back; linking the same user to a second employee of the same client throws (unique index); clearing the link works (`userId: null`).
- [ ] **Step 2: RED → implement → GREEN** (`npx vitest run tests/payroll/employees.test.ts`).
- [ ] **Step 3: UI:** two fields on the employee card form (user picker: client users; IBAN text input), i18n ×3. Web tsc clean.
- [ ] **Step 4: Report.**

---

### Task 8: `/expenses` page + approval-queue renderer + nav

**Files:**
- Create: `web/app/(cabinet)/expenses/page.tsx` + `page.module.css`, `web/app/components/ExpenseClaimDetails.tsx`
- Modify: nav (`web/app/components/NavIcon.tsx` + the cabinet nav list — find via `grep -rn "invoices" web/app/(cabinet)/layout.tsx web/app/components`), approval-queue payload rendering (where `BankMatchDetails` is used — same spot renders posting proposals; add claim context if the rationale alone is insufficient), `web/app/lib/i18n.ts`

**Interfaces:**
- Consumes: all `/api/expenses/*` routes (Task 6); `PaymentStatusBadge` styling family; the settle-drawer pattern from `web/app/(cabinet)/invoices/page.tsx`; composer-with-lines pattern from `web/app/(cabinet)/bills/page.tsx` (or wherever bill entry lives — grep).

- [ ] **Step 1: Build the page.** Employee view: own claims list (status badges: draft/submitted/approved/reimbursed/rejected), "New claim" composer — receipt lines (photo attach → `POST /api/expenses/upload` → prefill amount/date/merchant into the line, expense-account input, net/VAT + deductible toggle) and mileage lines (km input, rate shown from settings, live line total), live claim totals (cent-safe display via the existing money formatting helpers), Save draft / Submit. Firm view adds: all-employee claims, mileage-rate editor (PUT settings), reimburse actions — payment-order download (selected approved claims) + settle drawer (paidDate) mirroring `/invoices`.
- [ ] **Step 2: Nav entry + icon** (stroked SVG per `NavIcon.tsx` convention — a receipt/wallet glyph), i18n ×3 for every string.
- [ ] **Step 3: Approval queue:** verify a claim proposal renders comprehensibly (rationale text carries employee + lines summary from Task 3); add `ExpenseClaimDetails` only if the queue renders payload details for posting proposals — mirror how bills appear there today (investigate first; bills may rely on rationale alone — match that).
- [ ] **Step 4: Gates:** web tsc + `cd web && npm run build`. Report.

---

### Task 9: Docs

**Files:**
- Modify: `HANDOFF.md`, `docs/ROADMAP-market-gaps.md`, `CLAUDE.md` (only if a new convention emerged — likely not)

- [ ] ROADMAP M6 → ✅ shipped 2026-07-20 with a row note in the house style (module, flow, decisions: self-service via `employees.user_id`, bank payout, mileage, per-line deductible VAT; payroll-component payout + multi-currency deferred).
- [ ] HANDOFF progress block: M6 entry (same content, plus the new authz ops, migration 043, `'expense'` document source, account-mapping debt extended with 5610).
- [ ] Report.

---

### Task 10: Final gates + whole-branch review

- [ ] Controller runs: `npm run migrate` idempotency, full `npm test`, `npx tsc --noEmit` root + web, `cd web && npm run build`.
- [ ] Whole-branch review (workflow: fable, high effort) over `git diff main...expense-claims` with the riding-minors list from per-task reviews; fix Critical/Important on-branch; re-gate after fixes.

### Task 11: Merge to main + push

- [ ] `git checkout main && git merge --no-ff expense-claims` (summary body + session trailer) `&& git push origin main`.
- [ ] Post-merge: confirm tree identity with the tested branch head (`git diff <head> main --stat` empty) so gates carry over.

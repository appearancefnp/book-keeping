# Known-Issues Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three still-open correctness/authz issues from the HANDOFF debt register and the 2026-07-18 audit seed findings: (1) a rejected `bank_match` proposal strands its bank transaction in `matched`, (2) proposal approve/reject routes have no role gating, (3) migration filename numbering collisions have no guard.

**Architecture:** All fixes follow existing patterns — domain logic in `src/<module>/`, enforcement via the central `Operation` matrix in `src/authz/policy.ts`, tests mirroring `src/` under `tests/`. No new modules, no migrations, no UI changes.

**Tech Stack:** TypeScript (Node 24+), pg, vitest against real Postgres (`docker compose up -d db`).

## Global Constraints

- Ledger is append-only; money is integer cents via `src/db/money.ts`; never floats.
- Every domain call runs inside `withTenant(ctx, ...)`; mutations call `appendAudit(...)` (proposal transitions already audit via `transition()` — the bank-tx status revert mirrors `proposeMatches`, which does not separately audit the reservation flip).
- Verification before completion: `npm test` (repo root, needs the Docker Postgres) **and** `npx tsc --noEmit` in both root and `web/` must pass.
- Work on a new branch `fix/known-issues` cut from `main` (the current `report-export` branch is unrelated in-flight work).

**Status of previously-listed debt (do NOT re-implement):** route-level role gating (`src/authz/policy.ts` + adoption on 24 routes) and the shared `errorToStatus` helper (`web/app/lib/authz.ts`) already shipped via HANDOFF-audit-fixes. Only the proposals approve/reject handlers were missed — Task 2 covers exactly that gap.

---

### Task 1: Free the bank transaction when a bank_match proposal is rejected

A rejected `bank_match` proposal currently leaves its `bank_transactions` row `status='matched'` forever (`proposeMatches`/`proposeApMatches` set it at propose time; `rejectProposal` never reverts it), so the transaction is never re-proposed. Fix generically in the reject flow — all three `bank_match` payload variants (`receivable`, `payable_clearing`, `payable_direct`) carry `bankTransactionId`.

**Files:**
- Modify: `src/proposals/lifecycle.ts:34-36`
- Test: `tests/banking/reject-frees-transaction.test.ts` (create)

**Interfaces:**
- Consumes: `getProposal(tx, ctx, id)` (already imported in lifecycle.ts), `bank_transactions.status` enum `'unmatched' | 'matched' | 'reconciled'` (`src/banking/query.ts:4`).
- Produces: unchanged signature `rejectProposal(tx, ctx, id, reason): Promise<void>` — callers (`src/api/handlers.ts:62`, tests) need no changes.

- [ ] **Step 1: Write the failing test**

Create `tests/banking/reject-frees-transaction.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { importStatement } from '../../src/banking/import.js';
import { proposeMatches } from '../../src/banking/match.js';
import { rejectProposal } from '../../src/proposals/lifecycle.js';

const config = { receivablesAccount: '2310', bankAccount: '2620' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setupAndPropose(t: { firmId: string; clientCompanyId: string }) {
  return withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Credit sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '121.00' },
    ]});
    await importStatement(tx, ctx(t), { account: 'LV80', transactions: [
      { bookingDate: '2026-03-10', amountCents: '12100', currency: 'EUR', side: 'credit', reference: 'pmt', counterparty: 'SIA Klients', endToEndId: 'E1' },
    ]});
    return (await proposeMatches(tx, ctx(t), config)).proposalIds;
  });
}

async function txnStatus(t: { firmId: string; clientCompanyId: string }): Promise<string> {
  const r = await withTenant(ctx(t), (tx) =>
    tx.query(`SELECT status FROM bank_transactions WHERE client_company_id = $1`, [t.clientCompanyId]));
  return r.rows[0].status as string;
}

test('rejecting a bank_match reverts the transaction to unmatched and allows re-proposing', async () => {
  const t = await makeFirmAndClient();
  const ids = await setupAndPropose(t);
  expect(ids).toHaveLength(1);
  expect(await txnStatus(t)).toBe('matched');

  await withTenant(ctx(t), (tx) => rejectProposal(tx, ctx(t), ids[0]!, 'wrong candidate'));
  expect(await txnStatus(t)).toBe('unmatched');

  // The freed transaction is picked up again on the next propose run.
  const again = await withTenant(ctx(t), (tx) => proposeMatches(tx, ctx(t), config));
  expect(again.proposalIds).toHaveLength(1);
});

test('rejecting a non-bank_match proposal touches no bank transaction', async () => {
  const t = await makeFirmAndClient();
  const ids = await setupAndPropose(t);
  expect(await txnStatus(t)).toBe('matched');
  // Reject an unrelated task proposal — the matched transaction must stay matched.
  const { createProposal } = await import('../../src/proposals/proposals.js');
  const { id } = await withTenant(ctx(t), (tx) =>
    createProposal(tx, ctx(t), { type: 'task', payload: {}, rationale: {}, status: 'pending_approval' }));
  await withTenant(ctx(t), (tx) => rejectProposal(tx, ctx(t), id, 'no'));
  expect(await txnStatus(t)).toBe('matched');
  expect(ids).toHaveLength(1);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/banking/reject-frees-transaction.test.ts`
Expected: first test FAILS at `expect(await txnStatus(t)).toBe('unmatched')` (received `'matched'`); second test passes.

- [ ] **Step 3: Implement the fix**

In `src/proposals/lifecycle.ts`, replace `rejectProposal` (lines 34–36):

```typescript
export async function rejectProposal(tx: PoolClient, ctx: TenantContext, id: string, reason: string): Promise<void> {
  const prop = await getProposal(tx, ctx, id);
  await transition(tx, ctx, id, 'pending_approval', 'rejected', { rejectReason: reason });
  // A rejected bank match must free the reserved bank transaction so the next
  // propose run can re-propose it (HANDOFF finding: reject left it stuck 'matched').
  // All bank_match payload variants carry bankTransactionId.
  if (prop.type === 'bank_match') {
    const bankTransactionId = (prop.payload as { bankTransactionId?: string }).bankTransactionId;
    if (bankTransactionId) {
      await tx.query(
        `UPDATE bank_transactions SET status = 'unmatched'
         WHERE id = $1 AND client_company_id = $2 AND status = 'matched'`,
        [bankTransactionId, ctx.clientCompanyId],
      );
    }
  }
}
```

(`getProposal` is already imported at the top of the file; the `AND status = 'matched'` guard means an already-reconciled transaction is never regressed.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/banking/reject-frees-transaction.test.ts tests/proposals/lifecycle.test.ts`
Expected: PASS (both files — lifecycle regression check included).

- [ ] **Step 5: Commit**

```bash
git add src/proposals/lifecycle.ts tests/banking/reject-frees-transaction.test.ts
git commit -m "fix(banking): free bank transaction when a bank_match proposal is rejected"
```

---

### Task 2: Role-gate proposal approve/reject

`/api/proposals/[id]/approve` and `/api/proposals/[id]/reject` run only `resolveTenantContext` — a client-assigned `employee` can approve/reject postings directly. Per PRODUCT.md, deciding is for firm roles and the owner ("approves decisions with material consequences"); the employee is not a decider. Gate in the shared domain handlers (`src/api/handlers.ts`) so both the web routes and the mobile API surface are covered at once.

**Files:**
- Modify: `src/authz/policy.ts:10-39`
- Modify: `src/api/handlers.ts:41-65`
- Test: `tests/api/proposals-authz.test.ts` (create)

**Interfaces:**
- Consumes: `assertRoleAllowed(role, op)` from `src/authz/policy.ts`; `TenantContext.actorRole` (`src/tenancy/context.ts:5`); `approveHandler(req: AuthedRequest)` / `rejectHandler(req: AuthedRequest)` returning `Promise<ApiResponse>` (`{ status, body }`).
- Produces: new `Operation` member `'proposals.decide'` allowed for `['firm_admin', 'accountant', 'owner']`. Handler signatures unchanged; forbidden callers now get `{ status: 403 }`.

- [ ] **Step 1: Write the failing test**

Create `tests/api/proposals-authz.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { createUser, type UserRole } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login } from '../../src/auth/sessions.js';
import { assignUserToClient } from '../../src/auth/context.js';
import { createProposal, getProposal } from '../../src/proposals/proposals.js';
import { approveHandler, rejectHandler } from '../../src/api/handlers.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup(role: UserRole) {
  const firm = await createFirm('Firm');
  const client = await createClientCompany(firm.id, { name: 'SIA K', regNo: '40100000001' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: `${role}@t.lv`, password: 'password123', role });
  await assignUserToClient(userId, client.id);
  const { sessionToken } = await login(`${role}@t.lv`, 'password123', totpCodeFor(totpSecret, NOW), NOW);
  const cid = { firmId: firm.id, clientCompanyId: client.id, actorId: userId, actorRole: role };
  // A 'task' proposal: approval-only, no ledger post — perfect for authz tests.
  const { id: proposalId } = await withTenant(cid, (tx) =>
    createProposal(tx, cid, { type: 'task', payload: {}, rationale: {}, status: 'pending_approval' }));
  return { clientId: client.id, sessionToken, cid, proposalId };
}

test('employee may not reject a proposal (403, status unchanged)', async () => {
  const { clientId, sessionToken, cid, proposalId } = await setup('employee');
  const res = await rejectHandler({
    token: sessionToken, clientCompanyId: clientId, params: { id: proposalId },
    body: { reason: 'nope' }, atUnixSeconds: NOW,
  });
  expect(res.status).toBe(403);
  const p = await withTenant(cid, (tx) => getProposal(tx, cid, proposalId));
  expect(p.status).toBe('pending_approval');
});

test('employee may not approve a proposal (403)', async () => {
  const { clientId, sessionToken, proposalId } = await setup('employee');
  const res = await approveHandler({
    token: sessionToken, clientCompanyId: clientId, params: { id: proposalId }, atUnixSeconds: NOW,
  });
  expect(res.status).toBe(403);
});

test('accountant approves; owner rejects (both allowed)', async () => {
  const a = await setup('accountant');
  const ra = await approveHandler({
    token: a.sessionToken, clientCompanyId: a.clientId, params: { id: a.proposalId }, atUnixSeconds: NOW,
  });
  expect(ra.status).toBe(200);

  const o = await setup('owner');
  const ro = await rejectHandler({
    token: o.sessionToken, clientCompanyId: o.clientId, params: { id: o.proposalId },
    body: { reason: 'not now' }, atUnixSeconds: NOW,
  });
  expect(ro.status).toBe(200);
});
```

(If `createUser` in `src/auth/users.ts` rejects the literal role strings used here, check its `UserRole` union and use the exact member names — the matrix in `policy.ts` uses `firm_admin`, `accountant`, `owner`, `employee`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/api/proposals-authz.test.ts`
Expected: the two employee tests FAIL (received status 200, expected 403); the allowed-roles test passes.

- [ ] **Step 3: Add the operation to the policy matrix**

In `src/authz/policy.ts`, add to the `Operation` union (after `'payruns.write'`, line 19):

```typescript
  | 'payruns.write' // create accounts-payable pay-runs (SEPA pain.001)
  | 'proposals.decide'; // approve/reject proposals in the approval queue
```

and to `OPERATION_ROLES` (after the `'payruns.write'` entry, line 38):

```typescript
  'payruns.write': ['firm_admin', 'accountant', 'employee'],
  'proposals.decide': ['firm_admin', 'accountant', 'owner'],
```

- [ ] **Step 4: Enforce in the shared handlers**

In `src/api/handlers.ts`, add the import (after line 8):

```typescript
import { assertRoleAllowed } from '../authz/policy.js';
```

In `approveHandler`, insert immediately after the missing-id check (line 44):

```typescript
    try { assertRoleAllowed(ctx.actorRole, 'proposals.decide'); }
    catch (e) { return { status: 403, body: { error: e instanceof Error ? e.message : String(e) } }; }
```

In `rejectHandler`, insert the identical two lines immediately after its missing-id check (line 60):

```typescript
    try { assertRoleAllowed(ctx.actorRole, 'proposals.decide'); }
    catch (e) { return { status: 403, body: { error: e instanceof Error ? e.message : String(e) } }; }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/api/proposals-authz.test.ts tests/api/handlers.test.ts tests/authz`
Expected: PASS. If `tests/api/handlers.test.ts` exercised approve/reject with a role now denied (it uses accountant sessions — should be unaffected), fix the fixture role, never the policy.

- [ ] **Step 6: Commit**

```bash
git add src/authz/policy.ts src/api/handlers.ts tests/api/proposals-authz.test.ts
git commit -m "fix(authz): role-gate proposal approve/reject (proposals.decide)"
```

---

### Task 3: Guard against new migration-number collisions

`runMigrations()` (`src/db/migrate.ts`) orders by lexicographic filename and records applied files by full name — the four existing collisions (`023_client_tariffs`/`023_payroll_rules`, `024_onboarding_templates`/`024_payroll_settings`, `025_employees`/`025_invoice_profiles`, `026_invoice_profile_branding`/`026_payroll_inputs`) are therefore stable and must NOT be renamed (renaming would re-apply them on existing databases). The fix is a guard: grandfather the known four, fail the suite if a fifth collision or a malformed filename ever appears.

**Files:**
- Test: `tests/db/migration-numbering.test.ts` (create)

**Interfaces:**
- Consumes: the `migrations/` directory only (pure filesystem test, no DB).
- Produces: nothing — a CI tripwire.

- [ ] **Step 1: Write the test (it must pass immediately — this is a guard, not a bug fix)**

Create `tests/db/migration-numbering.test.ts`:

```typescript
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

// Applied migrations are recorded by full filename and ordered lexicographically,
// so these historical prefix collisions are stable — but NEW collisions create
// confusing, order-sensitive numbering. Never add to this set; take max+1 instead.
const GRANDFATHERED_DUPLICATE_PREFIXES = new Set(['023', '024', '025', '026']);

test('every migration filename is NNN_snake_case.sql', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    expect(f, `malformed migration filename: ${f}`).toMatch(/^\d{3}_[a-z0-9_]+\.sql$/);
  }
});

test('no NEW duplicate migration number prefixes beyond the grandfathered set', () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const byPrefix = new Map<string, string[]>();
  for (const f of files) {
    const prefix = f.slice(0, 3);
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), f]);
  }
  const offenders = [...byPrefix.entries()]
    .filter(([prefix, names]) => names.length > 1 && !GRANDFATHERED_DUPLICATE_PREFIXES.has(prefix));
  expect(offenders, `duplicate migration numbers: ${JSON.stringify(offenders)} — use max+1 across ALL files`).toEqual([]);
});
```

- [ ] **Step 2: Run the test to verify it passes against the current tree**

Run: `npx vitest run tests/db/migration-numbering.test.ts`
Expected: PASS (the guard accepts today's grandfathered collisions).

- [ ] **Step 3: Verify the guard actually trips**

Temporarily create `migrations/030_tripwire_check.sql` (any content), run the test again — Expected: FAIL naming prefix `030`. Then delete the file:

```bash
echo '-- tripwire' > migrations/030_tripwire_check.sql
npx vitest run tests/db/migration-numbering.test.ts   # must FAIL
rm migrations/030_tripwire_check.sql
npx vitest run tests/db/migration-numbering.test.ts   # must PASS again
```

- [ ] **Step 4: Commit**

```bash
git add tests/db/migration-numbering.test.ts
git commit -m "test(db): guard against new migration-number collisions"
```

---

### Task 4: Full verification

- [ ] **Step 1: Full backend suite** — Run from repo root: `npm test`. Expected: all tests pass (351 + the 5 new ones).
- [ ] **Step 2: Typecheck both packages** — Run: `npx tsc --noEmit && (cd web && npx tsc --noEmit)`. Expected: no errors.
- [ ] **Step 3: Update the debt register** — In `HANDOFF.md`, mark the "Bank-match reject doesn't free the transaction" bullet as fixed (with date) and note the new `proposals.decide` gating; commit:

```bash
git add HANDOFF.md
git commit -m "docs: mark bank-match reject + proposals gating debt as fixed"
```

---

## Out of scope (deliberately deferred — each needs its own plan or an external decision)

- **Hard-coded LR account codes** (`5310/5722/2620/2699` defaults in bills/pay-run/ap-aging routes) — blocked on a practising accountant confirming chart codes; belongs with the per-client account-mapping settings screen (tariffs/templates bucket).
- **AP amount-only matching + propose-time TOCTOU window** — needs reference/fuzzy matching design and a hard reservation; post-time guard already prevents double-posting.
- **Login rate limiting and audit-log hash chain** — security-hardening plan (audit Phase 4).
- **M2 minor cleanups** (tighten `vatRate` bound, dedupe `billIds`, `BillRow.status` union, `isValidIsoDate` centralisation, shared `fmtDate`/`statusLabel`, header-only `getBill`, single-load `resolveOrCreateVendor`) — batch as a `/simplify` pass, not correctness.
- **`web/app/(cabinet)/reports/page.tsx` split** (497 lines, 6 tabs) — refactor with the report-export UI work already in flight on `report-export`.

# Accounts Payable — Plan 2: Pay-out Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Plan 1 (`2026-07-10-accounts-payable-1-bills-core.md`) must be complete — this plan builds on the `bills`/`bill_lines` tables, `src/payables/bills.ts` (`getBill`, `listBills`), the approval hook, and `parties.iban`.

**Goal:** Pay open bills — settle them individually, batch them into a pay run that emits a SEPA pain.001 file, and reconcile the resulting bank debits via camt.053 — plus an aged-payables report; all cleared through a payments-in-transit account so the payable is cleared exactly once.

**Architecture:** Adds `bill_payments` + `pay_runs` tables and three `src/payables/` files: `settlement.ts` (the shared settle primitive), `pay-run.ts` (select bills → post to bank-clearing + pain.001), and `aging.ts`. Extends `src/banking/match.ts` to propose AP matches from camt.053 **debits** and `src/banking/confirm-match.ts` to post them (clear transit *or* settle directly). Reuses `generateSepaCreditTransfer` and the existing `bank_match` proposal type + approval dispatch unchanged.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Node, Postgres (`pg`), Next.js App Router, Vitest, Zod. Money as integer cents via `src/db/money.ts`.

Spec: `docs/superpowers/specs/2026-07-10-accounts-payable-design.md`.

## Global Constraints

- **Money:** integer cents via `src/db/money.ts` (`toCents`/`fromCents`/`sumCents`); never floats. Money columns are `bigint` cents.
- **Tenancy:** `(tx, ctx, ...)` inside `withTenant(ctx, ...)`; RLS at the DB; every mutation calls `appendAudit(...)`.
- **New tables:** full RLS block + `GRANT SELECT, INSERT, UPDATE ... TO bookkeeping_app` — copy `migrations/014_bank_transactions.sql`.
- **Ledger append-only:** `postEntry` needs an **open period** for the entry date and a **balanced** entry (Σdebit === Σcredit in cents).
- **Settlement clears the payable exactly once.** Pay run: `DR payables / CR bank-clearing`, bill → paid, `cleared_at` NULL. camt.053 debit clearing a pay-run payment: `DR bank-clearing / CR bank`, set `cleared_at` (no bill change). Bills paid outside a pay run: `DR payables / CR bank`, bill → paid. Sign check: the two pay-run legs net to `DR payables / CR bank`; the clearing account returns to zero.
- **Web API routes:** `runtime='nodejs'`, `dynamic='force-dynamic'`; `getSessionToken()` → `resolveTenantContext(...)` → `withTenant`; `errorToStatus(msg)` from `@/app/lib/authz`; `assertRoleAllowed(ctx.actorRole, '<perm>')` on mutations. `@domain/*` for domain, `@/app/*` for app.
- **Web framework caveat:** `web/AGENTS.md` — this Next.js differs from training data; consult `web/node_modules/next/dist/docs/` and mirror existing routes/pages (`web/app/api/bank/import/route.ts`, `web/app/(cabinet)/reports/page.tsx`).
- **Default account codes** (representative, *accountant to confirm*): payables `5310`, bank `2620`, **bank-clearing `2699`** (new — "Naudas līdzekļi ceļā / Payments in transit", type `asset`). VAT-input `5721`.
- **i18n:** all three catalogs (EN/LV/RU) in `web/app/lib/i18n.ts`; TS build fails on a missing key.
- **Commands:** `npm test` (root; Postgres up: `docker compose up -d`) and `npx tsc --noEmit` in root and `web/`.

## File Structure

New:
- `migrations/031_bill_payments.sql` — `bill_payments`, `pay_runs`.
- `src/payables/settlement.ts` — `settleBill`.
- `src/payables/pay-run.ts` — `createPayRun`, `listPayRuns`, `getPayRunXml`.
- `src/payables/aging.ts` — `apAging`.
- `tests/payables/settlement.test.ts`, `tests/payables/pay-run.test.ts`, `tests/payables/ap-match.test.ts`, `tests/payables/aging.test.ts`
- `web/app/api/pay-runs/route.ts` — POST create / GET list.
- `web/app/api/pay-runs/[id]/route.ts` — GET pain.001 XML.
- `web/app/api/reports/ap-aging/route.ts` — GET aging.
- `web/app/(cabinet)/bills/pay/page.tsx` + `page.module.css` — pay-run flow.

Modified:
- `src/banking/match.ts` — add `proposeApMatches`.
- `src/banking/confirm-match.ts` — branch `postApprovedBankMatch` on `payload.kind`.
- `web/app/api/bank/import/route.ts` — call `proposeApMatches` after import.
- `web/app/(cabinet)/reports/page.tsx` — add an "Aged payables" tab.
- `web/app/(cabinet)/bills/page.tsx` — add a "Pay bills" action.
- `web/app/lib/i18n.ts` — `payables.*`, `payrun.*`, `reports.tab.apaging` + aging strings.
- `web/app/lib/authz.ts` — `'payruns.write'` permission.
- `src/dev/seed.ts` — add the bank-clearing account `2699`.

---

### Task 1: Migration `031_bill_payments.sql`

**Files:**
- Create: `migrations/031_bill_payments.sql`

**Interfaces:**
- Produces `bill_payments` (with `cleared_at`) and `pay_runs`, consumed by settlement, pay-run, and matching.

- [ ] **Step 1: Write the migration**

Create `migrations/031_bill_payments.sql`:

```sql
-- Accounts payable: settlements and pay runs (M2, Plan 2).
CREATE TABLE pay_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  created_by uuid,
  total_cents bigint NOT NULL DEFAULT 0,
  pain001_xml text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pay_runs_client_idx ON pay_runs(client_company_id, created_at);

ALTER TABLE pay_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE pay_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY pay_runs_tenant_isolation ON pay_runs
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON pay_runs TO bookkeeping_app;

CREATE TABLE bill_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_company_id uuid NOT NULL REFERENCES client_companies(id),
  bill_id uuid NOT NULL REFERENCES bills(id),
  amount_cents bigint NOT NULL,
  paid_date date NOT NULL,
  method text NOT NULL CHECK (method IN ('pay_run','bank_match','manual')),
  pay_run_id uuid REFERENCES pay_runs(id),
  bank_transaction_id uuid REFERENCES bank_transactions(id),
  journal_entry_id uuid NOT NULL REFERENCES journal_entries(id),
  cleared_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bill_payments_bill_idx ON bill_payments(bill_id);
CREATE INDEX bill_payments_uncleared_idx ON bill_payments(client_company_id, method, cleared_at);

ALTER TABLE bill_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bill_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY bill_payments_tenant_isolation ON bill_payments
  USING (client_company_id = current_setting('app.current_client_id', true)::uuid)
  WITH CHECK (client_company_id = current_setting('app.current_client_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON bill_payments TO bookkeeping_app;
```

- [ ] **Step 2: Apply and verify**

Run: `docker compose up -d`, then `npx tsx -e "import('./src/db/migrate.js').then(m => m.runMigrations()).then(() => process.exit(0))"`
Expected: applies `031` without error.

- [ ] **Step 3: Commit**

```bash
git add migrations/031_bill_payments.sql
git commit -m "feat(payables): bill_payments + pay_runs schema (M2)"
```

---

### Task 2: `settlement.ts` — the settle primitive

**Files:**
- Create: `src/payables/settlement.ts`
- Test: `tests/payables/settlement.test.ts`

**Interfaces:**
- Consumes: `getBill` from `./bills.js`; `postEntry` from `../ledger/posting.js`; `toCents`, `fromCents` from `../db/money.js`; `appendAudit`.
- Produces:
  - `interface SettleArgs { billId: string; amountCents: string; paidDate: string; method: 'pay_run'|'bank_match'|'manual'; payablesAccount: string; creditAccount: string; payRunId?: string|null; bankTransactionId?: string|null; }`
  - `settleBill(tx, ctx, args: SettleArgs): Promise<{ entryId: string; billPaymentId: string }>` — posts `DR payables / CR creditAccount` for `amountCents`, inserts a `bill_payments` row, and advances the bill's `amount_paid_cents` / `status` (`partially_paid` or `paid`). Rejects amount ≤ 0 or > outstanding.

- [ ] **Step 1: Write the failing test**

Create `tests/payables/settlement.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { createBill, getBill } from '../../src/payables/bills.js';
import { settleBill } from '../../src/payables/settlement.js';

const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function openBill(net = '100.00', vat = '21.00') {
  const t = await makeFirmAndClient();
  const { billId } = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'VAT input', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '2699', name: 'In transit', type: 'asset' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    const v = await createParty(tx, ctx(t), { kind: 'vendor', name: 'Acme', iban: 'LV80B0000435195001' });
    const b = await createBill(tx, ctx(t), {
      vendorPartyId: v.id, billNumber: 'B-1', issueDate: '2026-03-01', dueDate: '2026-03-31', currency: 'EUR',
      lines: [{ description: 'x', expenseAccount: '7710', net, vatRate: 21, vat }],
    }, ACCTS);
    await approveProposal(tx, ctx(t), b.proposalId);
    await postApprovedPosting(tx, ctx(t), b.proposalId);
    return b;
  });
  return { t, billId };
}

test('full settlement marks the bill paid', async () => {
  const { t, billId } = await openBill(); // grand = 121.00 -> 12100c
  await withTenant(ctx(t), (tx) => settleBill(tx, ctx(t), {
    billId, amountCents: '12100', paidDate: '2026-03-15', method: 'bank_match',
    payablesAccount: '5310', creditAccount: '2620',
  }));
  const b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(b.status).toBe('paid');
  expect(b.outstandingCents).toBe('0');
});

test('partial settlement marks the bill partially_paid; a second completes it', async () => {
  const { t, billId } = await openBill();
  await withTenant(ctx(t), (tx) => settleBill(tx, ctx(t), {
    billId, amountCents: '5000', paidDate: '2026-03-15', method: 'manual', payablesAccount: '5310', creditAccount: '2620',
  }));
  let b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(b.status).toBe('partially_paid');
  expect(b.outstandingCents).toBe('7100');
  await withTenant(ctx(t), (tx) => settleBill(tx, ctx(t), {
    billId, amountCents: '7100', paidDate: '2026-03-20', method: 'manual', payablesAccount: '5310', creditAccount: '2620',
  }));
  b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(b.status).toBe('paid');
});

test('over-payment is rejected', async () => {
  const { t, billId } = await openBill();
  await expect(withTenant(ctx(t), (tx) => settleBill(tx, ctx(t), {
    billId, amountCents: '99999', paidDate: '2026-03-15', method: 'manual', payablesAccount: '5310', creditAccount: '2620',
  }))).rejects.toThrow(/outstanding/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/payables/settlement.test.ts`
Expected: FAIL — cannot find module `../../src/payables/settlement.js`.

- [ ] **Step 3: Write the implementation**

Create `src/payables/settlement.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getBill } from './bills.js';
import { postEntry } from '../ledger/posting.js';
import { toCents, fromCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export interface SettleArgs {
  billId: string;
  amountCents: string;
  paidDate: string;
  method: 'pay_run' | 'bank_match' | 'manual';
  payablesAccount: string;
  creditAccount: string;
  payRunId?: string | null;
  bankTransactionId?: string | null;
}

/** Post DR payables / CR creditAccount for amountCents, record the payment, advance bill status. */
export async function settleBill(
  tx: PoolClient, ctx: TenantContext, args: SettleArgs,
): Promise<{ entryId: string; billPaymentId: string }> {
  const bill = await getBill(tx, ctx, args.billId);
  const amount = BigInt(args.amountCents);
  const outstanding = BigInt(bill.outstandingCents);
  if (amount <= 0n) throw new Error(`Settlement amount must be positive (got ${args.amountCents})`);
  if (amount > outstanding) throw new Error(`Settlement ${args.amountCents} exceeds outstanding ${bill.outstandingCents}`);

  const dec = fromCents(amount);
  const { entryId } = await postEntry(tx, ctx, {
    date: args.paidDate, memo: `Bill payment ${bill.billNumber}`, currency: bill.currency,
    lines: [
      { accountCode: args.payablesAccount, debit: dec, credit: '0', description: 'Settle payable' },
      { accountCode: args.creditAccount, debit: '0', credit: dec, description: 'Payment' },
    ],
  });

  const pay = await tx.query(
    `INSERT INTO bill_payments(client_company_id, bill_id, amount_cents, paid_date, method, pay_run_id, bank_transaction_id, journal_entry_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.clientCompanyId, args.billId, amount.toString(), args.paidDate, args.method, args.payRunId ?? null, args.bankTransactionId ?? null, entryId],
  );
  const billPaymentId = pay.rows[0].id as string;

  const newPaid = BigInt(bill.amountPaidCents) + amount;
  const status = newPaid >= BigInt(bill.grandTotalCents) ? 'paid' : 'partially_paid';
  await tx.query(
    `UPDATE bills SET amount_paid_cents = $1, status = $2 WHERE id = $3 AND client_company_id = $4`,
    [newPaid.toString(), status, args.billId, ctx.clientCompanyId],
  );

  await appendAudit(tx, ctx, {
    action: 'settle', entityType: 'bill', entityId: args.billId,
    before: { amountPaidCents: bill.amountPaidCents, status: bill.status },
    after: { amountPaidCents: newPaid.toString(), status, method: args.method, entryId },
  });
  return { entryId, billPaymentId };
}
```

> `toCents` is imported for parity with sibling modules even though amounts arrive as cents here; if the linter flags it unused, drop the import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/payables/settlement.test.ts` → Expected: PASS (3 tests).
Run: `npx tsc --noEmit` (root) → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/payables/settlement.ts tests/payables/settlement.test.ts
git commit -m "feat(payables): settleBill primitive (partial-aware) (M2)"
```

---

### Task 3: `pay-run.ts` — batch pay + pain.001

**Files:**
- Create: `src/payables/pay-run.ts`
- Test: `tests/payables/pay-run.test.ts`

**Interfaces:**
- Consumes: `getBill` from `./bills.js`; `settleBill` from `./settlement.js`; `generateSepaCreditTransfer` from `../banking/sepa.js`; `fromCents`; `appendAudit`.
- Produces:
  - `interface PayRunAccounts { payablesAccount: string; bankClearingAccount: string; }`
  - `createPayRun(tx, ctx, args: { billIds: string[]; paidDate: string; accounts: PayRunAccounts }): Promise<{ payRunId: string; pain001Xml: string; totalCents: string }>` — settles each selected bill's full outstanding via `settleBill` (`CR bank-clearing`, `method='pay_run'`), stores the pain.001. Rejects (before any posting) if a bill is not `open`/`partially_paid`, has zero outstanding, or its vendor has no IBAN.
  - `listPayRuns(tx, ctx): Promise<{ id: string; totalCents: string; createdAt: string }[]>`
  - `getPayRunXml(tx, ctx, id: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `tests/payables/pay-run.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { createBill, getBill } from '../../src/payables/bills.js';
import { createPayRun } from '../../src/payables/pay-run.js';

const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };
const PR_ACCTS = { payablesAccount: '5310', bankClearingAccount: '2699' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function openBill(t: { firmId: string; clientCompanyId: string }, iban: string | null, num: string) {
  return withTenant(ctx(t), async (tx) => {
    const v = await createParty(tx, ctx(t), { kind: 'vendor', name: `V-${num}`, iban });
    const b = await createBill(tx, ctx(t), {
      vendorPartyId: v.id, billNumber: num, issueDate: '2026-03-01', dueDate: '2026-03-31', currency: 'EUR',
      lines: [{ description: 'x', expenseAccount: '7710', net: '100.00', vatRate: 0, vat: '0.00' }],
    }, ACCTS);
    await approveProposal(tx, ctx(t), b.proposalId);
    await postApprovedPosting(tx, ctx(t), b.proposalId);
    return b.billId;
  });
}

async function accounts(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    for (const [code, type] of [['7710','expense'],['5721','asset'],['5310','liability'],['2620','asset'],['2699','asset']] as const) {
      await createAccount(tx, ctx(t), { code, name: code, type });
    }
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
  });
}

test('createPayRun settles bills to bank-clearing and emits pain.001', async () => {
  const t = await makeFirmAndClient();
  await accounts(t);
  const b1 = await openBill(t, 'LV80BANK0000435195001', 'P-1');
  const res = await withTenant(ctx(t), (tx) => createPayRun(tx, ctx(t), { billIds: [b1], paidDate: '2026-03-20', accounts: PR_ACCTS }));
  expect(res.totalCents).toBe('10000');
  expect(res.pain001Xml).toContain('pain.001');
  expect(res.pain001Xml).toContain('LV80BANK0000435195001');
  const b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), b1));
  expect(b.status).toBe('paid');
});

test('a bill whose vendor lacks an IBAN is rejected before posting', async () => {
  const t = await makeFirmAndClient();
  await accounts(t);
  const b1 = await openBill(t, null, 'P-2');
  await expect(withTenant(ctx(t), (tx) => createPayRun(tx, ctx(t), { billIds: [b1], paidDate: '2026-03-20', accounts: PR_ACCTS })))
    .rejects.toThrow(/IBAN/i);
  const b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), b1));
  expect(b.status).toBe('open'); // unchanged
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/payables/pay-run.test.ts`
Expected: FAIL — cannot find module `../../src/payables/pay-run.js`.

- [ ] **Step 3: Write the implementation**

Create `src/payables/pay-run.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getBill } from './bills.js';
import { settleBill } from './settlement.js';
import { generateSepaCreditTransfer } from '../banking/sepa.js';
import { fromCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export interface PayRunAccounts { payablesAccount: string; bankClearingAccount: string; }

export async function createPayRun(
  tx: PoolClient, ctx: TenantContext,
  args: { billIds: string[]; paidDate: string; accounts: PayRunAccounts },
): Promise<{ payRunId: string; pain001Xml: string; totalCents: string }> {
  if (!args.billIds.length) throw new Error('Pay run needs at least one bill');

  // 1. Validate everything BEFORE any posting.
  const plan: { billId: string; amountCents: bigint; iban: string; reference: string }[] = [];
  for (const billId of args.billIds) {
    const bill = await getBill(tx, ctx, billId);
    if (bill.status !== 'open' && bill.status !== 'partially_paid') {
      throw new Error(`Bill ${bill.billNumber} is not payable (status=${bill.status})`);
    }
    const outstanding = BigInt(bill.outstandingCents);
    if (outstanding <= 0n) throw new Error(`Bill ${bill.billNumber} has nothing outstanding`);
    const v = await tx.query(`SELECT iban FROM parties WHERE id = $1 AND client_company_id = $2`, [bill.vendorPartyId, ctx.clientCompanyId]);
    const iban = v.rows[0]?.iban as string | null;
    if (!iban) throw new Error(`Vendor for bill ${bill.billNumber} has no IBAN`);
    plan.push({ billId, amountCents: outstanding, iban, reference: bill.billNumber });
  }

  const total = plan.reduce((a, p) => a + p.amountCents, 0n);

  // 2. Create the pay run row, then settle each bill against bank-clearing.
  const pr = await tx.query(
    `INSERT INTO pay_runs(client_company_id, created_by, total_cents) VALUES ($1,$2,$3) RETURNING id`,
    [ctx.clientCompanyId, ctx.actorId, total.toString()],
  );
  const payRunId = pr.rows[0].id as string;

  for (const p of plan) {
    await settleBill(tx, ctx, {
      billId: p.billId, amountCents: p.amountCents.toString(), paidDate: args.paidDate, method: 'pay_run',
      payablesAccount: args.accounts.payablesAccount, creditAccount: args.accounts.bankClearingAccount, payRunId,
    });
  }

  // 3. Build the SEPA file and store it.
  const pain001Xml = generateSepaCreditTransfer(plan.map((p) => ({ iban: p.iban, amount: fromCents(p.amountCents), reference: p.reference })));
  await tx.query(`UPDATE pay_runs SET pain001_xml = $1 WHERE id = $2 AND client_company_id = $3`, [pain001Xml, payRunId, ctx.clientCompanyId]);

  await appendAudit(tx, ctx, { action: 'create', entityType: 'pay_run', entityId: payRunId, before: null, after: { totalCents: total.toString(), bills: plan.length } });
  return { payRunId, pain001Xml, totalCents: total.toString() };
}

export async function listPayRuns(
  tx: PoolClient, ctx: TenantContext,
): Promise<{ id: string; totalCents: string; createdAt: string }[]> {
  const res = await tx.query(
    `SELECT id, total_cents::text AS "totalCents", to_char(created_at,'YYYY-MM-DD') AS "createdAt"
     FROM pay_runs WHERE client_company_id = $1 ORDER BY created_at DESC`,
    [ctx.clientCompanyId],
  );
  return res.rows;
}

export async function getPayRunXml(tx: PoolClient, ctx: TenantContext, id: string): Promise<string> {
  const res = await tx.query(`SELECT pain001_xml AS xml FROM pay_runs WHERE id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
  if (!res.rowCount) throw new Error(`Pay run not found: ${id}`);
  return res.rows[0].xml as string;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/payables/pay-run.test.ts` → Expected: PASS (2 tests).
Run: `npx tsc --noEmit` (root) → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/payables/pay-run.ts tests/payables/pay-run.test.ts
git commit -m "feat(payables): pay run — settle to clearing + pain.001 (M2)"
```

---

### Task 4: AP bank matching — propose + confirm

**Files:**
- Modify: `src/banking/match.ts` (add `proposeApMatches`)
- Modify: `src/banking/confirm-match.ts` (branch on `payload.kind`)
- Test: `tests/payables/ap-match.test.ts`

**Interfaces:**
- Consumes: `createProposal` (existing); `settleBill` from `../payables/settlement.js`; `postEntry`; `getProposal`.
- Produces:
  - `interface ApMatchConfig { payablesAccount: string; bankAccount: string; bankClearingAccount: string; }`
  - `proposeApMatches(tx, ctx, config: ApMatchConfig): Promise<{ proposalIds: string[] }>` — for each unmatched **debit** transaction: first try to match an uncleared `pay_run` `bill_payments` row of equal amount (→ payload `kind:'payable_clearing'`); else an `open`/`partially_paid` bill whose outstanding equals the amount (→ `kind:'payable_direct'`). Marks the bank transaction `matched`.
  - `postApprovedBankMatch` now branches: `payable_clearing` posts `DR bank-clearing / CR bank` and sets `bill_payments.cleared_at`; `payable_direct` calls `settleBill` (`CR bank`); otherwise the existing receivable path runs unchanged.

- [ ] **Step 1: Write the failing test**

Create `tests/payables/ap-match.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { postApprovedBankMatch } from '../../src/banking/confirm-match.js';
import { proposeApMatches } from '../../src/banking/match.js';
import { createBill, getBill } from '../../src/payables/bills.js';
import { createPayRun } from '../../src/payables/pay-run.js';
import { accountBalances } from '../../src/ledger/balances.js';

const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };
const AP_MATCH = { payablesAccount: '5310', bankAccount: '2620', bankClearingAccount: '2699' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    for (const [code, type] of [['7710','expense'],['5721','asset'],['5310','liability'],['2620','asset'],['2699','asset']] as const) {
      await createAccount(tx, ctx(t), { code, name: code, type });
    }
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
  });
  return t;
}
async function openBill(t: { firmId: string; clientCompanyId: string }, num: string, iban: string | null) {
  return withTenant(ctx(t), async (tx) => {
    const v = await createParty(tx, ctx(t), { kind: 'vendor', name: num, iban });
    const b = await createBill(tx, ctx(t), {
      vendorPartyId: v.id, billNumber: num, issueDate: '2026-03-01', dueDate: '2026-03-31', currency: 'EUR',
      lines: [{ description: 'x', expenseAccount: '7710', net: '100.00', vatRate: 0, vat: '0.00' }],
    }, ACCTS);
    await approveProposal(tx, ctx(t), b.proposalId);
    await postApprovedPosting(tx, ctx(t), b.proposalId);
    return b.billId;
  });
}
async function importDebit(t: { firmId: string; clientCompanyId: string }, amountCents: string) {
  await withTenant(ctx(t), (tx) => tx.query(
    `INSERT INTO bank_transactions(client_company_id, account, booking_date, amount_cents, currency, side, reference, end_to_end_id)
     VALUES ($1,'LV00TEST','2026-03-20',$2,'EUR','debit','pay','E2E-1')`,
    [ctx(t).clientCompanyId, amountCents]));
}

test('pay-run debit clears the transit account to zero', async () => {
  const t = await setup();
  const billId = await openBill(t, 'C-1', 'LV80BANK0000435195001');
  await withTenant(ctx(t), (tx) => createPayRun(tx, ctx(t), { billIds: [billId], paidDate: '2026-03-20', accounts: { payablesAccount: '5310', bankClearingAccount: '2699' } }));
  await importDebit(t, '10000');
  const { proposalIds } = await withTenant(ctx(t), (tx) => proposeApMatches(tx, ctx(t), AP_MATCH));
  expect(proposalIds).toHaveLength(1);
  await withTenant(ctx(t), async (tx) => { await approveProposal(tx, ctx(t), proposalIds[0]); await postApprovedBankMatch(tx, ctx(t), proposalIds[0]); });
  const rows = await withTenant(ctx(t), (tx) => accountBalances(tx, ctx(t), {}));
  expect(rows.find((r) => r.code === '2699')!.balance).toBe('0.00'); // transit netted to zero
});

test('non-pay-run debit settles an open bill directly', async () => {
  const t = await setup();
  const billId = await openBill(t, 'C-2', null); // no pay run
  await importDebit(t, '10000');
  const { proposalIds } = await withTenant(ctx(t), (tx) => proposeApMatches(tx, ctx(t), AP_MATCH));
  expect(proposalIds).toHaveLength(1);
  await withTenant(ctx(t), async (tx) => { await approveProposal(tx, ctx(t), proposalIds[0]); await postApprovedBankMatch(tx, ctx(t), proposalIds[0]); });
  const b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(b.status).toBe('paid');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/payables/ap-match.test.ts`
Expected: FAIL — `proposeApMatches` is not exported.

- [ ] **Step 3: Add `proposeApMatches` to `src/banking/match.ts`**

Append to `src/banking/match.ts`:

```typescript
export interface ApMatchConfig { payablesAccount: string; bankAccount: string; bankClearingAccount: string; }

/**
 * Propose settlements for unmatched debit transactions. Priority: an uncleared
 * pay-run payment of equal amount (clear the transit account), else an open bill
 * whose outstanding equals the amount (settle directly).
 * MVP limitation: amount-only matching, no dedup across pending proposals (mirrors proposeMatches).
 */
export async function proposeApMatches(
  tx: PoolClient, ctx: TenantContext, config: ApMatchConfig,
): Promise<{ proposalIds: string[] }> {
  const txns = await tx.query(
    `SELECT id, amount_cents::text AS "amountCents", reference, counterparty
     FROM bank_transactions
     WHERE client_company_id = $1 AND status = 'unmatched' AND side = 'debit'`,
    [ctx.clientCompanyId],
  );

  const proposalIds: string[] = [];
  for (const t of txns.rows) {
    const amountEur = (Number(t.amountCents) / 100).toFixed(2);

    // (a) Uncleared pay-run payment of equal amount → clear transit.
    const transit = await tx.query(
      `SELECT id FROM bill_payments
       WHERE client_company_id = $1 AND method = 'pay_run' AND cleared_at IS NULL AND amount_cents = $2::bigint
       ORDER BY created_at LIMIT 1`,
      [ctx.clientCompanyId, t.amountCents],
    );
    if (transit.rowCount) {
      const billPaymentId = transit.rows[0].id as string;
      const { id } = await createProposal(tx, ctx, {
        type: 'bank_match',
        payload: { kind: 'payable_clearing', bankTransactionId: t.id, billPaymentId, amountCents: t.amountCents, bankAccount: config.bankAccount, bankClearingAccount: config.bankClearingAccount },
        rationale: { ruleRef: 'ap-clearing', computation: `Bank debit of ${amountEur} EUR clears a pay-run payment.`, sourceRefs: { bankTransactionId: t.id, billPaymentId } } as Rationale,
        status: 'pending_approval',
      });
      await tx.query(`UPDATE bank_transactions SET status = 'matched' WHERE id = $1 AND client_company_id = $2`, [t.id, ctx.clientCompanyId]);
      proposalIds.push(id);
      continue;
    }

    // (b) Open/partially-paid bill whose outstanding equals the amount → settle directly.
    const bill = await tx.query(
      `SELECT id, bill_number AS "billNumber" FROM bills
       WHERE client_company_id = $1 AND status IN ('open','partially_paid')
         AND (grand_total_cents - amount_paid_cents) = $2::bigint
       ORDER BY due_date LIMIT 1`,
      [ctx.clientCompanyId, t.amountCents],
    );
    if (!bill.rowCount) continue;
    const billId = bill.rows[0].id as string;
    const { id } = await createProposal(tx, ctx, {
      type: 'bank_match',
      payload: { kind: 'payable_direct', bankTransactionId: t.id, billId, amountCents: t.amountCents, bankAccount: config.bankAccount, payablesAccount: config.payablesAccount },
      rationale: { ruleRef: 'ap-direct', computation: `Bank debit of ${amountEur} EUR settles bill ${bill.rows[0].billNumber}.`, sourceRefs: { bankTransactionId: t.id, billId } } as Rationale,
      status: 'pending_approval',
    });
    await tx.query(`UPDATE bank_transactions SET status = 'matched' WHERE id = $1 AND client_company_id = $2`, [t.id, ctx.clientCompanyId]);
    proposalIds.push(id);
  }
  return { proposalIds };
}
```

- [ ] **Step 4: Branch `postApprovedBankMatch` in `src/banking/confirm-match.ts`**

At the top of `postApprovedBankMatch`, after the `if (prop.status !== 'approved')` guard and before the existing receivable `payload` line, insert the AP branches:

```typescript
  const raw = prop.payload as { kind?: string; bankTransactionId: string; amountCents: string };

  // Read the bank transaction's booking date once (shared by all branches).
  const btRes = await tx.query(
    `SELECT to_char(booking_date,'YYYY-MM-DD') AS "bookingDate", currency FROM bank_transactions WHERE id = $1 AND client_company_id = $2`,
    [raw.bankTransactionId, ctx.clientCompanyId],
  );
  if (!btRes.rowCount) throw new Error(`Bank transaction not found: ${raw.bankTransactionId}`);
  const { bookingDate, currency } = btRes.rows[0];
  const amountDec = centsToDecimal(raw.amountCents);

  if (raw.kind === 'payable_clearing') {
    const p = prop.payload as { billPaymentId: string; bankAccount: string; bankClearingAccount: string };
    const { entryId } = await postEntry(tx, ctx, {
      date: bookingDate, memo: `Clear pay-run transit (match ${proposalId})`, currency,
      lines: [
        { accountCode: p.bankClearingAccount, debit: amountDec, credit: '0', description: 'Clear transit' },
        { accountCode: p.bankAccount, debit: '0', credit: amountDec, description: 'Bank payment' },
      ],
    });
    await tx.query(`UPDATE bill_payments SET cleared_at = now() WHERE id = $1 AND client_company_id = $2`, [p.billPaymentId, ctx.clientCompanyId]);
    await tx.query(`UPDATE proposals SET status='posted', resolved_entry_id=$1, resolved_by=$2, resolved_at=now() WHERE id=$3 AND client_company_id=$4`, [entryId, ctx.actorId, proposalId, ctx.clientCompanyId]);
    await tx.query(`UPDATE bank_transactions SET status='reconciled', matched_entry_id=$1 WHERE id=$2 AND client_company_id=$3`, [entryId, raw.bankTransactionId, ctx.clientCompanyId]);
    await appendAudit(tx, ctx, { action: 'posted', entityType: 'bank_match', entityId: proposalId, before: { status: 'approved' }, after: { status: 'posted', entryId, kind: 'payable_clearing' } });
    return { entryId };
  }

  if (raw.kind === 'payable_direct') {
    const p = prop.payload as { billId: string; payablesAccount: string; bankAccount: string };
    const { settleBill } = await import('../payables/settlement.js');
    const { entryId } = await settleBill(tx, ctx, {
      billId: p.billId, amountCents: raw.amountCents, paidDate: bookingDate, method: 'bank_match',
      payablesAccount: p.payablesAccount, creditAccount: p.bankAccount, bankTransactionId: raw.bankTransactionId,
    });
    await tx.query(`UPDATE proposals SET status='posted', resolved_entry_id=$1, resolved_by=$2, resolved_at=now() WHERE id=$3 AND client_company_id=$4`, [entryId, ctx.actorId, proposalId, ctx.clientCompanyId]);
    await tx.query(`UPDATE bank_transactions SET status='reconciled', matched_entry_id=$1 WHERE id=$2 AND client_company_id=$3`, [entryId, raw.bankTransactionId, ctx.clientCompanyId]);
    await appendAudit(tx, ctx, { action: 'posted', entityType: 'bank_match', entityId: proposalId, before: { status: 'approved' }, after: { status: 'posted', entryId, kind: 'payable_direct' } });
    return { entryId };
  }
```

Ensure `postEntry` is imported in `confirm-match.ts` (it already is). The existing receivable code below this block is unchanged. (The `settleBill` dynamic `import()` avoids a static cycle between `banking` and `payables`; a top-level import is fine too if no cycle warning appears.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/payables/ap-match.test.ts` → Expected: PASS (2 tests).
Run: `npm test -- tests/banking` → Expected: existing receivable matching unaffected.
Run: `npx tsc --noEmit` (root) → Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/banking/match.ts src/banking/confirm-match.ts tests/payables/ap-match.test.ts
git commit -m "feat(payables): camt.053 debit matching — clear transit or settle bill (M2)"
```

---

### Task 5: `aging.ts` — aged payables

**Files:**
- Create: `src/payables/aging.ts`
- Test: `tests/payables/aging.test.ts`

**Interfaces:**
- Consumes: `TenantContext`; `fromCents`.
- Produces:
  - `interface ApAging { asOf: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90plus: string; total: string; }`
  - `apAging(tx, ctx, opts: { asOf: string }): Promise<ApAging>` — over bills `status IN ('open','partially_paid')`, bucketing **outstanding** cents by `(asOf − due_date)` in days: `current` (≤ 0, not yet due), `1–30`, `31–60`, `61–90`, `90+`. Amounts are decimal strings.

- [ ] **Step 1: Write the failing test**

Create `tests/payables/aging.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { createBill } from '../../src/payables/bills.js';
import { apAging } from '../../src/payables/aging.js';

const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function billDue(t: { firmId: string; clientCompanyId: string }, dueDate: string, net: string, num: string) {
  return withTenant(ctx(t), async (tx) => {
    const v = await createParty(tx, ctx(t), { kind: 'vendor', name: num });
    const b = await createBill(tx, ctx(t), {
      vendorPartyId: v.id, billNumber: num, issueDate: '2026-01-01', dueDate, currency: 'EUR',
      lines: [{ description: 'x', expenseAccount: '7710', net, vatRate: 0, vat: '0.00' }],
    }, ACCTS);
    await approveProposal(tx, ctx(t), b.proposalId);
    await postApprovedPosting(tx, ctx(t), b.proposalId);
    return b.billId;
  });
}

test('apAging buckets outstanding by due date vs asOf', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    for (const [code, type] of [['7710','expense'],['5721','asset'],['5310','liability']] as const) await createAccount(tx, ctx(t), { code, name: code, type });
    for (const m of [1,2,3,4,5,6]) await openPeriod(tx, ctx(t), { year: 2026, month: m });
  });
  await billDue(t, '2026-07-01', '100.00', 'A'); // asOf 2026-06-15 → not due → current
  await billDue(t, '2026-06-01', '50.00', 'B');  // 14 days overdue → 1–30
  await billDue(t, '2026-04-01', '20.00', 'C');  // 75 days overdue → 61–90
  const aging = await withTenant(ctx(t), (tx) => apAging(tx, ctx(t), { asOf: '2026-06-15' }));
  expect(aging.current).toBe('100.00');
  expect(aging.d1_30).toBe('50.00');
  expect(aging.d61_90).toBe('20.00');
  expect(aging.total).toBe('170.00');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/payables/aging.test.ts`
Expected: FAIL — cannot find module `../../src/payables/aging.js`.

- [ ] **Step 3: Write the implementation**

Create `src/payables/aging.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { fromCents } from '../db/money.js';

export interface ApAging {
  asOf: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90plus: string; total: string;
}

/** Aged payables: outstanding on open/partially-paid bills, bucketed by (asOf - due_date). */
export async function apAging(
  tx: PoolClient, ctx: TenantContext, opts: { asOf: string },
): Promise<ApAging> {
  const res = await tx.query(
    `SELECT ($2::date - due_date) AS days, (grand_total_cents - amount_paid_cents) AS outstanding
     FROM bills
     WHERE client_company_id = $1 AND status IN ('open','partially_paid')
       AND (grand_total_cents - amount_paid_cents) > 0`,
    [ctx.clientCompanyId, opts.asOf],
  );

  let current = 0n, d1_30 = 0n, d31_60 = 0n, d61_90 = 0n, d90plus = 0n;
  for (const r of res.rows) {
    const days = Number(r.days);
    const amt = BigInt(r.outstanding);
    if (days <= 0) current += amt;
    else if (days <= 30) d1_30 += amt;
    else if (days <= 60) d31_60 += amt;
    else if (days <= 90) d61_90 += amt;
    else d90plus += amt;
  }
  const total = current + d1_30 + d31_60 + d61_90 + d90plus;
  return {
    asOf: opts.asOf,
    current: fromCents(current), d1_30: fromCents(d1_30), d31_60: fromCents(d31_60),
    d61_90: fromCents(d61_90), d90plus: fromCents(d90plus), total: fromCents(total),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/payables/aging.test.ts` → Expected: PASS.
Run: `npx tsc --noEmit` (root) → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/payables/aging.ts tests/payables/aging.test.ts
git commit -m "feat(payables): aged-payables report (M2)"
```

---

### Task 6: API routes — pay-runs, ap-aging; wire AP matching into import

**Files:**
- Modify: `web/app/lib/authz.ts` (add `'payruns.write'`)
- Create: `web/app/api/pay-runs/route.ts`, `web/app/api/pay-runs/[id]/route.ts`, `web/app/api/reports/ap-aging/route.ts`
- Modify: `web/app/api/bank/import/route.ts`

**Interfaces:**
- Produces:
  - `POST /api/pay-runs` body `{ clientCompanyId, billIds[], paidDate }` → `{ payRunId, totalCents, pain001Xml }` (201)
  - `GET /api/pay-runs?clientCompanyId=` → `{ payRuns: [...] }`
  - `GET /api/pay-runs/:id?clientCompanyId=` → pain.001 XML (content-type `application/xml`, attachment)
  - `GET /api/reports/ap-aging?clientCompanyId=&asOf=` → `{ report: ApAging }`
  - `POST /api/bank/import` additionally proposes AP matches after importing.

- [ ] **Step 1: Add the permission**

In `web/app/lib/authz.ts`, add `'payruns.write'` mirroring `'bills.write'` (same role set).

- [ ] **Step 2: Write the pay-runs route**

Create `web/app/api/pay-runs/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { createPayRun, listPayRuns } from '@domain/payables/pay-run.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

const PR_ACCOUNTS = { payablesAccount: '5310', bankClearingAccount: '2699' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const payRuns = await withTenant(ctx, (tx) => listPayRuns(tx, ctx));
    return NextResponse.json({ payRuns }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; billIds?: string[]; paidDate?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.billIds?.length) return NextResponse.json({ error: 'no bills selected' }, { status: 400 });
  const paidDate = body.paidDate ?? new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(paidDate)) return NextResponse.json({ error: 'paidDate must be YYYY-MM-DD' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'payruns.write');
    const result = await withTenant(ctx, (tx) => createPayRun(tx, ctx, { billIds: body.billIds!, paidDate, accounts: PR_ACCOUNTS }));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 3: Write the pay-run XML download route**

Create `web/app/api/pay-runs/[id]/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { getPayRunXml } from '@domain/payables/pay-run.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await context.params;
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const xml = await withTenant(ctx, (tx) => getPayRunXml(tx, ctx, id));
    return new NextResponse(xml, { status: 200, headers: { 'content-type': 'application/xml', 'content-disposition': `attachment; filename="payrun-${id}.xml"` } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 4: Write the ap-aging route**

Create `web/app/api/reports/ap-aging/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { apAging } from '@domain/payables/aging.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const asOf = req.nextUrl.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(asOf)) return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const report = await withTenant(ctx, (tx) => apAging(tx, ctx, { asOf }));
    return NextResponse.json({ report }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 5: Wire AP matching into the import route**

In `web/app/api/bank/import/route.ts`, import `proposeApMatches` and call it right after `importStatement` inside the same `withTenant`:

```typescript
import { proposeApMatches } from '@domain/banking/match.js';
// ...
const AP_MATCH = { payablesAccount: '5310', bankAccount: '2620', bankClearingAccount: '2699' };
// replace the import line with:
    const result = await withTenant(ctx, async (tx) => {
      const imported = await importStatement(tx, ctx, stmt);
      const ap = await proposeApMatches(tx, ctx, AP_MATCH);
      return { ...imported, apProposals: ap.proposalIds.length };
    });
```

- [ ] **Step 6: Verify typecheck**

Run: `cd web && npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/app/lib/authz.ts web/app/api/pay-runs "web/app/api/pay-runs/[id]" web/app/api/reports/ap-aging/route.ts web/app/api/bank/import/route.ts
git commit -m "feat(web): pay-run + ap-aging API; propose AP matches on import (M2)"
```

---

### Task 7: Pay-run UI + aged-payables tab + i18n

**Files:**
- Create: `web/app/(cabinet)/bills/pay/page.tsx` + `page.module.css`
- Modify: `web/app/(cabinet)/bills/page.tsx` (add "Pay bills" link)
- Modify: `web/app/(cabinet)/reports/page.tsx` (add "Aged payables" tab)
- Modify: `web/app/lib/i18n.ts`

**Interfaces:**
- Consumes: `/api/bills?status=open`, `/api/pay-runs`, `/api/pay-runs/:id`, `/api/reports/ap-aging`.

- [ ] **Step 1: Add i18n keys (all three catalogs)**

In `web/app/lib/i18n.ts`, add to **EN** (then the LV and RU equivalents — translate the values, keep the keys identical so the TS guard passes):

```typescript
  'bills.pay': 'Pay bills',
  'payrun.title': 'Pay run',
  'payrun.select': 'Select bills to pay',
  'payrun.paidDate': 'Payment date',
  'payrun.generate': 'Generate payment file',
  'payrun.download': 'Download pain.001',
  'payrun.none': 'No open bills to pay.',
  'payrun.done': 'Payment file generated.',
  'reports.tab.apaging': 'Aged payables',
  'reports.aging.current': 'Not yet due',
  'reports.aging.d1_30': '1–30 days',
  'reports.aging.d31_60': '31–60 days',
  'reports.aging.d61_90': '61–90 days',
  'reports.aging.d90plus': '90+ days',
  'reports.aging.total': 'Total payable',
```

Suggested LV: `bills.pay`='Apmaksāt rēķinus', `payrun.title`='Maksājumu partija', `payrun.select`='Izvēlieties apmaksājamos rēķinus', `payrun.paidDate`='Maksājuma datums', `payrun.generate`='Ģenerēt maksājuma failu', `payrun.download`='Lejupielādēt pain.001', `payrun.none`='Nav atvērtu rēķinu apmaksai.', `payrun.done`='Maksājuma fails izveidots.', `reports.tab.apaging`='Kreditoru parādi pēc termiņa', `reports.aging.current`='Vēl nav termiņa', `reports.aging.d1_30`='1–30 dienas', `reports.aging.d31_60`='31–60 dienas', `reports.aging.d61_90`='61–90 dienas', `reports.aging.d90plus`='90+ dienas', `reports.aging.total`='Kopā saistības'.

Suggested RU: `bills.pay`='Оплатить счета', `payrun.title`='Платёжный пакет', `payrun.select`='Выберите счета к оплате', `payrun.paidDate`='Дата платежа', `payrun.generate`='Сформировать платёжный файл', `payrun.download`='Скачать pain.001', `payrun.none`='Нет открытых счетов к оплате.', `payrun.done`='Платёжный файл сформирован.', `reports.tab.apaging`='Задолженность по срокам', `reports.aging.current`='Срок не наступил', `reports.aging.d1_30`='1–30 дней', `reports.aging.d31_60`='31–60 дней', `reports.aging.d61_90`='61–90 дней', `reports.aging.d90plus`='90+ дней', `reports.aging.total`='Итого к оплате'.

- [ ] **Step 2: Add the "Pay bills" link on `/bills`**

In `web/app/(cabinet)/bills/page.tsx`, in the `.header` block next to the "New bill" link, add:

```tsx
          <Link className={styles.newButton} href={`/bills/pay${q}`}>{t('bills.pay')}</Link>
```

- [ ] **Step 3: Write the pay-run page**

Create `web/app/(cabinet)/bills/pay/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import styles from './page.module.css';

interface BillRow { id: string; vendorName: string; billNumber: string; dueDate: string; outstandingCents: string; }
function money(cents: string): string { return new Intl.NumberFormat('lv-LV', { minimumFractionDigits: 2 }).format(Number(cents) / 100); }

function PayInner() {
  const { t } = useMessages();
  const client = useSearchParams().get('client');
  const [bills, setBills] = useState<BillRow[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [paidDate, setPaidDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setError(null); setBills(null);
    try {
      const [open, partial] = await Promise.all([
        fetch(`/api/bills?clientCompanyId=${encodeURIComponent(client)}&status=open`, { cache: 'no-store' }).then((r) => r.json()),
        fetch(`/api/bills?clientCompanyId=${encodeURIComponent(client)}&status=partially_paid`, { cache: 'no-store' }).then((r) => r.json()),
      ]);
      setBills([...(open.bills ?? []), ...(partial.bills ?? [])]);
    } catch (err) { setError((err as Error).message); }
  }, [client]);
  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const generate = useCallback(async () => {
    if (!client || sel.size === 0) return;
    setError(null);
    try {
      const res = await fetch('/api/pay-runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, billIds: [...sel], paidDate }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const data = await res.json();
      setRunId(data.payRunId);
      setSel(new Set());
      load();
    } catch (err) { setError((err as Error).message); }
  }, [client, sel, paidDate, load]);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('payrun.title')}</h1>
        {error && <ErrorState message={error} onRetry={load} />}
        {runId && (
          <div className={styles.done}>
            {t('payrun.done')}{' '}
            <a href={`/api/pay-runs/${runId}?clientCompanyId=${encodeURIComponent(client!)}`}>{t('payrun.download')}</a>
          </div>
        )}
        {!error && !bills && <SkeletonCard />}
        {!error && bills && bills.length === 0 && <EmptyState message={t('payrun.none')} />}
        {!error && bills && bills.length > 0 && (
          <>
            <label className={styles.field}>{t('payrun.paidDate')}
              <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
            </label>
            <table className={styles.table}>
              <thead><tr><th /><th>{t('bills.vendor')}</th><th>{t('bills.number')}</th><th>{t('bills.dueDate')}</th><th className={styles.right}>{t('bills.outstanding')}</th></tr></thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id}>
                    <td><input type="checkbox" checked={sel.has(b.id)} onChange={() => toggle(b.id)} /></td>
                    <td>{b.vendorName}</td><td>{b.billNumber}</td><td>{b.dueDate}</td>
                    <td className={styles.right}>{money(b.outstandingCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className={styles.generate} disabled={sel.size === 0} onClick={generate}>{t('payrun.generate')}</button>
          </>
        )}
      </main>
    </div>
  );
}

export default function PayRunPage() {
  return <Suspense fallback={<SkeletonCard />}><PayInner /></Suspense>;
}
```

Create `web/app/(cabinet)/bills/pay/page.module.css`:

```css
.page { display: flex; flex-direction: column; }
.main { width: 100%; max-width: 52rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
.pageHeading { font-size: 1.5rem; font-weight: 650; margin: 0 0 1rem; }
.field { display: flex; flex-direction: column; gap: .25rem; font-size: .8125rem; color: var(--muted, #6b7280); margin-bottom: 1rem; max-width: 12rem; }
.field input { font: inherit; padding: .375rem .5rem; border: 1px solid var(--border, #e5e7eb); border-radius: .375rem; }
.table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
.table th { text-align: left; font-size: .75rem; color: var(--muted, #6b7280); padding: .375rem .5rem; border-bottom: 1px solid var(--border, #e5e7eb); }
.table td { padding: .5rem; border-bottom: 1px solid var(--border-subtle, #f3f4f6); }
.right { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.generate { appearance: none; cursor: pointer; font: inherit; padding: .625rem 1rem; border: none; border-radius: .375rem; background: var(--fg, #111827); color: var(--bg, #fff); }
.generate:disabled { opacity: .5; cursor: not-allowed; }
.done { padding: .75rem 1rem; border: 1px solid var(--ok, #15803d); color: var(--ok, #15803d); border-radius: .375rem; margin-bottom: 1rem; }
```

- [ ] **Step 4: Add the "Aged payables" tab to `/reports`**

In `web/app/(cabinet)/reports/page.tsx`:
1. Widen the tab type: `type Tab = 'pl' | 'bs' | 'apaging';`.
2. Add an aging state + type near the others:
```tsx
interface ApAging { asOf: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90plus: string; total: string; }
const [aging, setAging] = useState<ApAging | null>(null);
```
3. In the `load` callback, add a branch (mirror the existing `pl`/`bs` fetch shape; `apaging` uses the `asOf` state already present for the BS tab):
```tsx
      } else if (tab === 'apaging') {
        const url = `/api/reports/ap-aging?clientCompanyId=${encodeURIComponent(clientCompanyId)}&asOf=${asOf}`;
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        setAging((await res.json()).report as ApAging); setPl(null); setBs(null);
      }
```
(and add `aging`/`asOf` to the `load` dependency array).
4. Add the tab button next to the others:
```tsx
          <button role="tab" aria-selected={tab === 'apaging'} className={tab === 'apaging' ? styles.tabActive : styles.tab} onClick={() => setTab('apaging')}>{t('reports.tab.apaging')}</button>
```
5. Reuse the BS tab's `asOf` date control for `apaging` (change the control's condition from `tab === 'bs'` to `tab !== 'pl'`).
6. Render the aging table:
```tsx
        {!error && !loading && tab === 'apaging' && aging && (
          <div className={styles.statement}>
            <table className={styles.table}><tbody>
              <tr><td className={styles.name}>{t('reports.aging.current')}</td><td className={styles.amount}>{fmtMoney(aging.current)}</td></tr>
              <tr><td className={styles.name}>{t('reports.aging.d1_30')}</td><td className={styles.amount}>{fmtMoney(aging.d1_30)}</td></tr>
              <tr><td className={styles.name}>{t('reports.aging.d31_60')}</td><td className={styles.amount}>{fmtMoney(aging.d31_60)}</td></tr>
              <tr><td className={styles.name}>{t('reports.aging.d61_90')}</td><td className={styles.amount}>{fmtMoney(aging.d61_90)}</td></tr>
              <tr><td className={styles.name}>{t('reports.aging.d90plus')}</td><td className={styles.amount}>{fmtMoney(aging.d90plus)}</td></tr>
            </tbody></table>
            <div className={styles.grandTotal}><span>{t('reports.aging.total')}</span><span className={styles.amount}>{fmtMoney(aging.total)}</span></div>
          </div>
        )}
```

- [ ] **Step 5: Verify build + smoke test**

Run: `cd web && npx tsc --noEmit` → Expected: no errors.
Run: `cd web && npm run build` → Expected: succeeds; `/bills/pay` in the route list.

Manual (Postgres up; seed has `2699`): open a bill and approve it (Plan 1 flow); `/bills` → "Pay bills" → tick it (vendor must have an IBAN — set one on `/parties`), pick a date, Generate → download the pain.001. Import a camt.053 with a matching debit on `/bank` → an AP match proposal appears in the queue; approving it reconciles the bank line and (for a pay-run payment) nets account `2699` to zero on `/journal`. `/reports` → "Aged payables" shows the buckets.

- [ ] **Step 6: Commit**

```bash
git add "web/app/(cabinet)/bills/pay" "web/app/(cabinet)/bills/page.tsx" "web/app/(cabinet)/reports/page.tsx" web/app/lib/i18n.ts
git commit -m "feat(web): pay-run UI + aged-payables tab (M2)"
```

---

### Task 8: Full verification + docs

**Files:**
- Modify: `src/dev/seed.ts` (add `2699`), `HANDOFF.md`, `docs/ROADMAP-market-gaps.md`

- [ ] **Step 1: Seed the bank-clearing account**

In `src/dev/seed.ts`, add to the accounts array:
```typescript
  { code: '2699', name: 'Naudas līdzekļi ceļā (Payments in transit)', type: 'asset' },
```

- [ ] **Step 2: Run the whole suite**

Run: `npm test` (root) → Expected: all pass, including every `tests/payables/*` and untouched banking/reports suites.
Run: `npx tsc --noEmit` (root) and `cd web && npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 3: Update roadmap + handoff**

In `docs/ROADMAP-market-gaps.md`, set M2 to ✅ with: "Shipped 2026-07-10 — `src/payables/` (bills, settlement, pay-run, aging), camt.053 debit matching (clear transit / settle direct), `/bills` + pay-run UI, aged-payables tab on `/reports`. Full money-out loop. M5 now has its AP half." In `HANDOFF.md`, update the market-gaps progress note (M2 done; next unblocked: M3 live bank feeds, M4 AR lifecycle).

- [ ] **Step 4: Commit**

```bash
git add src/dev/seed.ts HANDOFF.md docs/ROADMAP-market-gaps.md
git commit -m "docs: mark M2 accounts payable shipped; seed clearing account (M2)"
```

---

## Self-Review notes

- **Spec coverage (Plan 2 portion):** bill_payments + pay_runs schema with `cleared_at` (Task 1) ✓; partial-aware `settleBill` (Task 2) ✓; pay run → clearing + pain.001, IBAN-required (Task 3) ✓; camt.053 debit matching — clear transit *or* settle direct, transit nets to zero (Task 4) ✓; aged payables (Task 5) ✓; API + import wiring (Task 6) ✓; pay-run UI + aging tab + i18n (Task 7) ✓; verify + docs (Task 8) ✓.
- **Placeholder scan:** no TBD/TODO; every code step has full code. i18n LV/RU values are provided inline for translation with identical keys.
- **Type consistency:** `SettleArgs`/`settleBill` return `{ entryId, billPaymentId }` used by pay-run and the AP-direct branch; `PayRunAccounts`, `ApMatchConfig`, `ApAging` are defined once and imported by routes; `payload.kind` discriminator (`payable_clearing`/`payable_direct`) is written in `proposeApMatches` and read in `postApprovedBankMatch`; `bill_payments.cleared_at` is set by proposeApMatches candidate filter and the clearing branch.
- **Convention match:** new-table RLS blocks copied from `014`; `(tx, ctx, …)` inside `withTenant`; integer-cent money; `appendAudit` on every mutation; reuse of the existing `bank_match` proposal type + approve dispatch (no new dispatch); route auth/error pattern from `bank/import` + `parties`.
- **Correctness guardrails covered by tests:** transit account nets to zero after a pay-run debit clears (Task 4 test asserts `2699` == `0.00`); over-payment rejected; IBAN-less vendor rejected before any posting; partial then completing settlement; aging bucket boundaries.
- **Assumptions flagged:** default codes `5310/2620/2699/5721` representative — accountant to confirm; AP matching is amount-only (documented MVP limitation mirroring `proposeMatches`); a per-client account-mapping settings screen remains deferred.
```

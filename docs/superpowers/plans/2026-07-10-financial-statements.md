# Financial Statements (M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add on-demand Profit & Loss and Balance Sheet statements for any period, computed live from the append-only ledger, on a new `/reports` screen.

**Architecture:** A shared `accountBalances(tx, ctx, {from,to})` SQL primitive in `src/ledger/balances.ts` (which `trialBalance` is refactored to reuse) feeds two pure assemblers in `src/reports/`. Read-only API routes expose them; a `/reports` cabinet page renders them with a period picker. No migration — statements key off the existing `accounts.type` column.

**Tech Stack:** TypeScript, Node, Postgres (`pg`), Next.js App Router, Vitest, Zod. Money as integer cents via `src/db/money.ts`.

## Global Constraints

- **Money:** integer cents via `src/db/money.ts` (`toCents`/`fromCents`/`sumCents`); never floats. DB returns 2-dp numeric text.
- **Tenancy:** domain functions are `(tx, ctx, ...)` run inside `withTenant(ctx, ...)`; RLS enforced at DB. Web routes: `getSessionToken()` → `resolveTenantContext(token, clientCompanyId, nowUnix())` → domain call inside `withTenant`; error mapping `/session/i.test(msg) ? 401 : 403` (add 400 for bad query params).
- **Classification is by `accounts.type`** (`asset|liability|equity|income|expense`), never by code prefix. Rows ordered by `code`.
- **i18n:** every user-facing string added to all three catalogs (EN, LV, RU) in `web/app/lib/i18n.ts`. TS build fails if a key is missing from any catalog. Dates via `LOCALE_FOR[lang]`.
- **Icons:** inline stroked SVG, `currentColor`, ~1.5px (see `web/app/components/NavIcon.tsx`). No emoji.
- **Commands:** `npm test` (root, Vitest, needs Postgres up) and `npx tsc --noEmit` in both root and `web/`.
- **Append-only ledger:** corrections are reversals; a posting + its reversal must net to zero in every statement.

## File Structure

New:
- `src/reports/profit-and-loss.ts` — `profitAndLoss()` assembler + its types.
- `src/reports/balance-sheet.ts` — `balanceSheet()` assembler + its types.
- `tests/reports/profit-and-loss.test.ts`
- `tests/reports/balance-sheet.test.ts`
- `web/app/api/reports/profit-and-loss/route.ts`
- `web/app/api/reports/balance-sheet/route.ts`
- `web/app/(cabinet)/reports/page.tsx`
- `web/app/(cabinet)/reports/page.module.css`

Modified:
- `src/ledger/balances.ts` — add `accountBalances`; `trialBalance` reuses it.
- `web/app/lib/i18n.ts` — EN/LV/RU `reports.*` and `nav.reports` strings.
- `web/app/components/NavIcon.tsx` — add `'reports'` icon.
- `web/app/components/Sidebar.tsx` — add `/reports` nav entry.

---

### Task 1: `accountBalances` primitive + refactor `trialBalance`

**Files:**
- Modify: `src/ledger/balances.ts`
- Test: `tests/reports/balances.test.ts` (Create)

**Interfaces:**
- Consumes: `TenantContext` from `../tenancy/context.js`; `AccountType` from `./accounts.js`.
- Produces:
  - `interface DatedBalanceRow { code: string; name: string; type: AccountType; debit: string; credit: string; balance: string; }`
  - `accountBalances(tx: PoolClient, ctx: TenantContext, range: { from?: string; to?: string }): Promise<DatedBalanceRow[]>` — `from`/`to` inclusive `YYYY-MM-DD` bounds on `entry_date`; both optional. `balance = SUM(debit) - SUM(credit)` (debit-normal). Includes zero-balance accounts (LEFT JOIN), ordered by `code`.
  - `trialBalance(tx, ctx): Promise<TrialBalanceRow[]>` — unchanged signature, now delegates to `accountBalances(tx, ctx, {})`.

- [ ] **Step 1: Write the failing test**

Create `tests/reports/balances.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { accountBalances } from '../../src/ledger/balances.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seed() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 2 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    // Feb sale: DR bank 100 / CR sales 100
    await postEntry(tx, ctx(t), {
      date: '2026-02-15', memo: 'Feb sale', currency: 'EUR',
      lines: [
        { accountCode: '2620', debit: '100.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '100.00' },
      ],
    });
    // Mar sale: DR bank 50 / CR sales 50
    await postEntry(tx, ctx(t), {
      date: '2026-03-15', memo: 'Mar sale', currency: 'EUR',
      lines: [
        { accountCode: '2620', debit: '50.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '50.00' },
      ],
    });
  });
  return t;
}

test('accountBalances with no range sums everything (== trial balance)', async () => {
  const t = await seed();
  const rows = await withTenant(ctx(t), (tx) => accountBalances(tx, ctx(t), {}));
  const bank = rows.find((r) => r.code === '2620')!;
  const sales = rows.find((r) => r.code === '6110')!;
  expect(bank.balance).toBe('150.00');   // 150 debit
  expect(sales.balance).toBe('-150.00'); // 150 credit → debit-normal negative
  expect(bank.type).toBe('asset');
  expect(sales.type).toBe('income');
});

test('accountBalances filters by entry_date range (inclusive)', async () => {
  const t = await seed();
  const rows = await withTenant(ctx(t), (tx) =>
    accountBalances(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  const bank = rows.find((r) => r.code === '2620')!;
  expect(bank.balance).toBe('50.00'); // only the March entry
});

test('accountBalances includes zero-balance accounts', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => createAccount(tx, ctx(t), { code: '1000', name: 'Idle', type: 'asset' }));
  const rows = await withTenant(ctx(t), (tx) => accountBalances(tx, ctx(t), {}));
  expect(rows.find((r) => r.code === '1000')!.balance).toBe('0.00');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/reports/balances.test.ts`
Expected: FAIL — `accountBalances` is not exported from `balances.js`.

- [ ] **Step 3: Write the implementation**

Replace the contents of `src/ledger/balances.ts` with:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccountType } from './accounts.js';

export interface TrialBalanceRow { code: string; name: string; debit: string; credit: string; balance: string; }
export interface DatedBalanceRow extends TrialBalanceRow { type: AccountType; }

/**
 * Per-account debit/credit/balance, optionally bounded by entry_date.
 * `balance` is debit-normal: SUM(debit) - SUM(credit). Includes accounts with
 * no lines in range (zero rows). Ordered by code. RLS scopes journal rows;
 * accounts are additionally filtered by tenant to match trialBalance().
 */
export async function accountBalances(
  tx: PoolClient,
  ctx: TenantContext,
  range: { from?: string; to?: string } = {},
): Promise<DatedBalanceRow[]> {
  const res = await tx.query(`
    SELECT a.code, a.name, a.type,
           COALESCE(SUM(jl.debit), 0)::numeric(18,2)::text  AS debit,
           COALESCE(SUM(jl.credit), 0)::numeric(18,2)::text AS credit,
           (COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0))::numeric(18,2)::text AS balance
    FROM accounts a
    LEFT JOIN (
      SELECT l.account_id, l.debit, l.credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      WHERE ($2::date IS NULL OR e.entry_date >= $2::date)
        AND ($3::date IS NULL OR e.entry_date <= $3::date)
    ) jl ON jl.account_id = a.id
    WHERE a.client_company_id = $1
    GROUP BY a.code, a.name, a.type
    ORDER BY a.code
  `, [ctx.clientCompanyId, range.from ?? null, range.to ?? null]);
  return res.rows;
}

export async function trialBalance(tx: PoolClient, ctx: TenantContext): Promise<TrialBalanceRow[]> {
  return accountBalances(tx, ctx, {});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/reports/balances.test.ts` → Expected: PASS (3 tests).
Run: `npm test -- tests/ledger` → Expected: PASS (existing trialBalance callers unaffected).
Run: `npx tsc --noEmit` (root) → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/balances.ts tests/reports/balances.test.ts
git commit -m "feat(reports): accountBalances primitive; trialBalance reuses it (M1)"
```

---

### Task 2: `profitAndLoss` assembler

**Files:**
- Create: `src/reports/profit-and-loss.ts`
- Test: `tests/reports/profit-and-loss.test.ts`

**Interfaces:**
- Consumes: `accountBalances`, `DatedBalanceRow` from `../ledger/balances.js`; `toCents`, `fromCents` from `../db/money.js`.
- Produces:
  - `interface StatementLine { code: string; name: string; amount: string; }`
  - `interface StatementSection { lines: StatementLine[]; subtotal: string; }`
  - `interface ProfitAndLoss { from: string | null; to: string | null; income: StatementSection; expense: StatementSection; netProfit: string; }`
  - `profitAndLoss(tx: PoolClient, ctx: TenantContext, range: { from?: string; to?: string }): Promise<ProfitAndLoss>`
  - Income lines credit-normal (`amount = credit - debit`); expense lines debit-normal (`amount = debit - credit`). Zero-`amount` lines omitted. `netProfit = income.subtotal - expense.subtotal`. All money via `money.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/reports/profit-and-loss.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry, reverseEntry } from '../../src/ledger/posting.js';
import { profitAndLoss } from '../../src/reports/profit-and-loss.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function base() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 4 });
  });
  return t;
}

test('profitAndLoss computes income, expense, and net', async () => {
  const t = await base();
  await withTenant(ctx(t), async (tx) => {
    // Sale 300: DR bank / CR sales
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '300.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '300.00' },
    ]});
    // Expense 120: DR expenses / CR bank
    await postEntry(tx, ctx(t), { date: '2026-03-12', memo: 'Cost', currency: 'EUR', lines: [
      { accountCode: '7710', debit: '120.00', credit: '0' },
      { accountCode: '2620', debit: '0', credit: '120.00' },
    ]});
  });
  const pl = await withTenant(ctx(t), (tx) => profitAndLoss(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(pl.income.subtotal).toBe('300.00');
  expect(pl.expense.subtotal).toBe('120.00');
  expect(pl.netProfit).toBe('180.00');
  expect(pl.income.lines).toHaveLength(1);
  expect(pl.income.lines[0]).toMatchObject({ code: '6110', amount: '300.00' });
  expect(pl.expense.lines[0]).toMatchObject({ code: '7710', amount: '120.00' });
});

test('profitAndLoss omits zero-balance accounts and asset/liability accounts', async () => {
  const t = await base();
  await withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
    { accountCode: '2620', debit: '50.00', credit: '0' },
    { accountCode: '6110', debit: '0', credit: '50.00' },
  ]}));
  const pl = await withTenant(ctx(t), (tx) => profitAndLoss(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(pl.income.lines).toHaveLength(1);   // sales only
  expect(pl.expense.lines).toHaveLength(0);   // 7710 has zero balance → omitted
});

test('profitAndLoss excludes entries outside the date range', async () => {
  const t = await base();
  await withTenant(ctx(t), async (tx) => {
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Mar', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '100.00', credit: '0' }, { accountCode: '6110', debit: '0', credit: '100.00' },
    ]});
    await postEntry(tx, ctx(t), { date: '2026-04-10', memo: 'Apr', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '999.00', credit: '0' }, { accountCode: '6110', debit: '0', credit: '999.00' },
    ]});
  });
  const pl = await withTenant(ctx(t), (tx) => profitAndLoss(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(pl.income.subtotal).toBe('100.00');
});

test('profitAndLoss nets out a reversal', async () => {
  const t = await base();
  const posted = await withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
    { accountCode: '2620', debit: '80.00', credit: '0' }, { accountCode: '6110', debit: '0', credit: '80.00' },
  ]}));
  await withTenant(ctx(t), (tx) => reverseEntry(tx, ctx(t), posted.entryId, 'oops'));
  const pl = await withTenant(ctx(t), (tx) => profitAndLoss(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(pl.income.subtotal).toBe('0.00');
  expect(pl.netProfit).toBe('0.00');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/reports/profit-and-loss.test.ts`
Expected: FAIL — cannot find module `../../src/reports/profit-and-loss.js`.

- [ ] **Step 3: Write the implementation**

Create `src/reports/profit-and-loss.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { accountBalances, type DatedBalanceRow } from '../ledger/balances.js';
import { toCents, fromCents } from '../db/money.js';

export interface StatementLine { code: string; name: string; amount: string; }
export interface StatementSection { lines: StatementLine[]; subtotal: string; }
export interface ProfitAndLoss {
  from: string | null;
  to: string | null;
  income: StatementSection;
  expense: StatementSection;
  netProfit: string;
}

/** Build a section from rows of one type. `sign` flips debit-normal balance to
 *  the natural presentation sign (credit-normal for income, debit-normal for
 *  expense). Zero-amount lines are omitted. */
function section(rows: DatedBalanceRow[], normal: 'credit' | 'debit'): StatementSection {
  const lines: StatementLine[] = [];
  let subtotal = 0n;
  for (const r of rows) {
    // r.balance is debit-normal (debit - credit).
    const debitNormal = toCents(r.balance);
    const amount = normal === 'credit' ? -debitNormal : debitNormal;
    if (amount === 0n) continue;
    lines.push({ code: r.code, name: r.name, amount: fromCents(amount) });
    subtotal += amount;
  }
  return { lines, subtotal: fromCents(subtotal) };
}

export async function profitAndLoss(
  tx: PoolClient,
  ctx: TenantContext,
  range: { from?: string; to?: string },
): Promise<ProfitAndLoss> {
  const rows = await accountBalances(tx, ctx, range);
  const income = section(rows.filter((r) => r.type === 'income'), 'credit');
  const expense = section(rows.filter((r) => r.type === 'expense'), 'debit');
  const netProfit = fromCents(toCents(income.subtotal) - toCents(expense.subtotal));
  return { from: range.from ?? null, to: range.to ?? null, income, expense, netProfit };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/reports/profit-and-loss.test.ts` → Expected: PASS (4 tests).
Run: `npx tsc --noEmit` (root) → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/reports/profit-and-loss.ts tests/reports/profit-and-loss.test.ts
git commit -m "feat(reports): profitAndLoss assembler (M1)"
```

---

### Task 3: `balanceSheet` assembler

**Files:**
- Create: `src/reports/balance-sheet.ts`
- Test: `tests/reports/balance-sheet.test.ts`

**Interfaces:**
- Consumes: `accountBalances`, `DatedBalanceRow` from `../ledger/balances.js`; `StatementLine`, `StatementSection` from `./profit-and-loss.js`; `toCents`, `fromCents` from `../db/money.js`.
- Produces:
  - `interface BalanceSheet { asOf: string; assets: StatementSection; liabilities: StatementSection; equity: StatementSection; currentPeriodResult: string; totalAssets: string; totalLiabilitiesAndEquity: string; balanced: boolean; }`
  - `balanceSheet(tx: PoolClient, ctx: TenantContext, opts: { asOf: string }): Promise<BalanceSheet>`
  - Uses `accountBalances(tx, ctx, { to: asOf })`. Assets debit-normal; liabilities & equity credit-normal. `equity` section includes a synthetic `currentPeriodResult` line (`{ code: '', name: 'Current-period result', amount }`, amount = Σincome − Σexpense to `asOf`) — but only when non-zero — and its subtotal includes it. `balanced = totalAssets === totalLiabilitiesAndEquity`.

- [ ] **Step 1: Write the failing test**

Create `tests/reports/balance-sheet.test.ts`:

```typescript
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { balanceSheet } from '../../src/reports/balance-sheet.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seed() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await createAccount(tx, ctx(t), { code: '3300', name: 'Share capital', type: 'equity' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    // Owner injects capital: DR bank 1000 / CR equity 1000
    await postEntry(tx, ctx(t), { date: '2026-03-01', memo: 'Capital', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '1000.00', credit: '0' },
      { accountCode: '3300', debit: '0', credit: '1000.00' },
    ]});
    // Sale 300 on credit: DR bank 300 / CR sales 300
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '300.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '300.00' },
    ]});
    // Buy on credit: DR expenses 120 / CR payables 120
    await postEntry(tx, ctx(t), { date: '2026-03-12', memo: 'Cost', currency: 'EUR', lines: [
      { accountCode: '7710', debit: '120.00', credit: '0' },
      { accountCode: '5310', debit: '0', credit: '120.00' },
    ]});
  });
  return t;
}

test('balanceSheet classifies and balances', async () => {
  const t = await seed();
  const bs = await withTenant(ctx(t), (tx) => balanceSheet(tx, ctx(t), { asOf: '2026-03-31' }));
  expect(bs.totalAssets).toBe('1300.00');            // bank 1000 + 300
  expect(bs.currentPeriodResult).toBe('180.00');     // sales 300 - expenses 120
  expect(bs.totalLiabilitiesAndEquity).toBe('1300.00'); // payables 120 + capital 1000 + result 180
  expect(bs.balanced).toBe(true);
});

test('balanceSheet includes the current-period result as an equity line', async () => {
  const t = await seed();
  const bs = await withTenant(ctx(t), (tx) => balanceSheet(tx, ctx(t), { asOf: '2026-03-31' }));
  const resultLine = bs.equity.lines.find((l) => l.name === 'Current-period result');
  expect(resultLine?.amount).toBe('180.00');
  expect(bs.equity.subtotal).toBe('1180.00'); // capital 1000 + result 180
});

test('balanceSheet respects asOf (later entries excluded)', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '3300', name: 'Capital', type: 'equity' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 4 });
    await postEntry(tx, ctx(t), { date: '2026-03-01', memo: 'Capital', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '500.00', credit: '0' }, { accountCode: '3300', debit: '0', credit: '500.00' },
    ]});
    await postEntry(tx, ctx(t), { date: '2026-04-01', memo: 'More', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '500.00', credit: '0' }, { accountCode: '3300', debit: '0', credit: '500.00' },
    ]});
  });
  const bs = await withTenant(ctx(t), (tx) => balanceSheet(tx, ctx(t), { asOf: '2026-03-31' }));
  expect(bs.totalAssets).toBe('500.00');
  expect(bs.balanced).toBe(true);
});

test('empty ledger is balanced at zero', async () => {
  const t = await makeFirmAndClient();
  const bs = await withTenant(ctx(t), (tx) => balanceSheet(tx, ctx(t), { asOf: '2026-03-31' }));
  expect(bs.totalAssets).toBe('0.00');
  expect(bs.totalLiabilitiesAndEquity).toBe('0.00');
  expect(bs.balanced).toBe(true);
  expect(bs.currentPeriodResult).toBe('0.00');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/reports/balance-sheet.test.ts`
Expected: FAIL — cannot find module `../../src/reports/balance-sheet.js`.

- [ ] **Step 3: Write the implementation**

Create `src/reports/balance-sheet.ts`:

```typescript
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { accountBalances, type DatedBalanceRow } from '../ledger/balances.js';
import type { StatementLine, StatementSection } from './profit-and-loss.js';
import { toCents, fromCents } from '../db/money.js';

export interface BalanceSheet {
  asOf: string;
  assets: StatementSection;
  liabilities: StatementSection;
  equity: StatementSection;
  currentPeriodResult: string;
  totalAssets: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;
}

const RESULT_LINE_NAME = 'Current-period result';

/** Build a section, flipping to the natural presentation sign. Zero lines omitted. */
function section(rows: DatedBalanceRow[], normal: 'credit' | 'debit'): { lines: StatementLine[]; subtotal: bigint } {
  const lines: StatementLine[] = [];
  let subtotal = 0n;
  for (const r of rows) {
    const debitNormal = toCents(r.balance);
    const amount = normal === 'credit' ? -debitNormal : debitNormal;
    if (amount === 0n) continue;
    lines.push({ code: r.code, name: r.name, amount: fromCents(amount) });
    subtotal += amount;
  }
  return { lines, subtotal };
}

export async function balanceSheet(
  tx: PoolClient,
  ctx: TenantContext,
  opts: { asOf: string },
): Promise<BalanceSheet> {
  const rows = await accountBalances(tx, ctx, { to: opts.asOf });

  const assets = section(rows.filter((r) => r.type === 'asset'), 'debit');
  const liabilities = section(rows.filter((r) => r.type === 'liability'), 'credit');
  const equityBase = section(rows.filter((r) => r.type === 'equity'), 'credit');

  // Current-period result folded into equity (no period-closing yet):
  // Σincome (credit-normal) − Σexpense (debit-normal), both to asOf.
  let result = 0n;
  for (const r of rows) {
    if (r.type === 'income') result += -toCents(r.balance); // credit-normal
    else if (r.type === 'expense') result -= toCents(r.balance); // debit-normal
  }

  const equityLines = [...equityBase.lines];
  if (result !== 0n) equityLines.push({ code: '', name: RESULT_LINE_NAME, amount: fromCents(result) });
  const equitySubtotal = equityBase.subtotal + result;

  const totalAssets = assets.subtotal;
  const totalLiabEquity = liabilities.subtotal + equitySubtotal;

  return {
    asOf: opts.asOf,
    assets: { lines: assets.lines, subtotal: fromCents(assets.subtotal) },
    liabilities: { lines: liabilities.lines, subtotal: fromCents(liabilities.subtotal) },
    equity: { lines: equityLines, subtotal: fromCents(equitySubtotal) },
    currentPeriodResult: fromCents(result),
    totalAssets: fromCents(totalAssets),
    totalLiabilitiesAndEquity: fromCents(totalLiabEquity),
    balanced: totalAssets === totalLiabEquity,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/reports/balance-sheet.test.ts` → Expected: PASS (4 tests).
Run: `npx tsc --noEmit` (root) → Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/reports/balance-sheet.ts tests/reports/balance-sheet.test.ts
git commit -m "feat(reports): balanceSheet assembler with current-period result (M1)"
```

---

### Task 4: API routes

**Files:**
- Create: `web/app/api/reports/profit-and-loss/route.ts`
- Create: `web/app/api/reports/balance-sheet/route.ts`

**Interfaces:**
- Consumes: `profitAndLoss` from `@domain/reports/profit-and-loss.js`; `balanceSheet` from `@domain/reports/balance-sheet.js`; `resolveTenantContext`, `withTenant`, `getSessionToken`, `nowUnix` (existing web helpers).
- Produces: `GET /api/reports/profit-and-loss?clientCompanyId=&from=&to=` → `{ report: ProfitAndLoss }`; `GET /api/reports/balance-sheet?clientCompanyId=&asOf=` → `{ report: BalanceSheet }`. Dates validated as `YYYY-MM-DD`; invalid → 400. Defaults: P&L `from` = first of current month, `to` = today; BS `asOf` = today.

- [ ] **Step 1: Write the P&L route**

Create `web/app/api/reports/profit-and-loss/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { profitAndLoss } from '@domain/reports/profit-and-loss.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function firstOfMonthIso(): string { return todayIso().slice(0, 8) + '01'; }

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  const from = req.nextUrl.searchParams.get('from') ?? firstOfMonthIso();
  const to = req.nextUrl.searchParams.get('to') ?? todayIso();
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json({ error: 'from/to must be YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const report = await withTenant(ctx, (tx) => profitAndLoss(tx, ctx, { from, to }));
    return NextResponse.json({ report }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 2: Write the Balance Sheet route**

Create `web/app/api/reports/balance-sheet/route.ts`:

```typescript
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { balanceSheet } from '@domain/reports/balance-sheet.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  const asOf = req.nextUrl.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(asOf)) {
    return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const report = await withTenant(ctx, (tx) => balanceSheet(tx, ctx, { asOf }));
    return NextResponse.json({ report }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd web && npx tsc --noEmit` → Expected: no errors. (Confirms `@domain/reports/*` resolves and types line up.)

- [ ] **Step 4: Commit**

```bash
git add web/app/api/reports/profit-and-loss/route.ts web/app/api/reports/balance-sheet/route.ts
git commit -m "feat(web): reports API routes for P&L and balance sheet (M1)"
```

---

### Task 5: i18n strings + nav icon + sidebar entry

**Files:**
- Modify: `web/app/lib/i18n.ts`
- Modify: `web/app/components/NavIcon.tsx`
- Modify: `web/app/components/Sidebar.tsx`

**Interfaces:**
- Produces: i18n keys `nav.reports`, `nav.short.reports`, and `reports.*` (listed below) present in all three catalogs; `NavIconName` includes `'reports'`; Sidebar shows a `/reports` entry for accountant/firm_admin and owner.

- [ ] **Step 1: Add the `'reports'` icon**

In `web/app/components/NavIcon.tsx`, add `| 'reports'` to the `NavIconName` union (after `'settings'`), and add this entry to the `PATHS` record (a bar-chart glyph):

```tsx
  // Reports / financial statements (bar chart)
  reports: (
    <>
      <path d="M3.5 16.5h13" strokeLinecap="round" />
      <path d="M6 16.5V11M10 16.5V6M14 16.5v-3.5" strokeLinecap="round" />
    </>
  ),
```

- [ ] **Step 2: Add i18n keys to all three catalogs**

In `web/app/lib/i18n.ts`, add to the **EN** object (near the `nav.journal` entries add `nav.reports`; add a new `reports.*` block near the `journal.*` block):

```typescript
  'nav.reports': 'Reports',
  'nav.short.reports': 'Reports',
  'reports.title': 'Financial statements',
  'reports.tab.pl': 'Profit & Loss',
  'reports.tab.bs': 'Balance Sheet',
  'reports.from': 'From',
  'reports.to': 'To',
  'reports.asOf': 'As of',
  'reports.preset.month': 'This month',
  'reports.preset.quarter': 'This quarter',
  'reports.preset.year': 'This year',
  'reports.income': 'Income',
  'reports.expense': 'Expenses',
  'reports.netProfit': 'Net profit',
  'reports.netLoss': 'Net loss',
  'reports.assets': 'Assets',
  'reports.liabilities': 'Liabilities',
  'reports.equity': 'Equity',
  'reports.currentResult': 'Current-period result',
  'reports.totalAssets': 'Total assets',
  'reports.totalLiabEquity': 'Total liabilities & equity',
  'reports.balanced': 'Balanced',
  'reports.unbalanced': 'Not balanced — data integrity issue',
  'reports.empty': 'No entries for this period.',
  'reports.emptyDetail': 'Approved postings in the selected range will appear here.',
```

Then add the **same keys** with Latvian values to the LV object:

```typescript
  'nav.reports': 'Pārskati',
  'nav.short.reports': 'Pārskati',
  'reports.title': 'Finanšu pārskati',
  'reports.tab.pl': 'Peļņas un zaudējumu aprēķins',
  'reports.tab.bs': 'Bilance',
  'reports.from': 'No',
  'reports.to': 'Līdz',
  'reports.asOf': 'Uz datumu',
  'reports.preset.month': 'Šis mēnesis',
  'reports.preset.quarter': 'Šis ceturksnis',
  'reports.preset.year': 'Šis gads',
  'reports.income': 'Ieņēmumi',
  'reports.expense': 'Izdevumi',
  'reports.netProfit': 'Neto peļņa',
  'reports.netLoss': 'Neto zaudējumi',
  'reports.assets': 'Aktīvi',
  'reports.liabilities': 'Saistības',
  'reports.equity': 'Pašu kapitāls',
  'reports.currentResult': 'Pārskata perioda rezultāts',
  'reports.totalAssets': 'Aktīvi kopā',
  'reports.totalLiabEquity': 'Saistības un pašu kapitāls kopā',
  'reports.balanced': 'Sabalansēts',
  'reports.unbalanced': 'Nav sabalansēts — datu integritātes kļūda',
  'reports.empty': 'Šajā periodā nav ierakstu.',
  'reports.emptyDetail': 'Šeit parādīsies apstiprinātās grāmatojumu operācijas izvēlētajā periodā.',
```

Then add the **same keys** with Russian values to the RU object:

```typescript
  'nav.reports': 'Отчёты',
  'nav.short.reports': 'Отчёты',
  'reports.title': 'Финансовые отчёты',
  'reports.tab.pl': 'Отчёт о прибылях и убытках',
  'reports.tab.bs': 'Баланс',
  'reports.from': 'С',
  'reports.to': 'По',
  'reports.asOf': 'На дату',
  'reports.preset.month': 'Этот месяц',
  'reports.preset.quarter': 'Этот квартал',
  'reports.preset.year': 'Этот год',
  'reports.income': 'Доходы',
  'reports.expense': 'Расходы',
  'reports.netProfit': 'Чистая прибыль',
  'reports.netLoss': 'Чистый убыток',
  'reports.assets': 'Активы',
  'reports.liabilities': 'Обязательства',
  'reports.equity': 'Капитал',
  'reports.currentResult': 'Результат текущего периода',
  'reports.totalAssets': 'Итого активы',
  'reports.totalLiabEquity': 'Итого обязательства и капитал',
  'reports.balanced': 'Сбалансировано',
  'reports.unbalanced': 'Не сбалансировано — проблема целостности данных',
  'reports.empty': 'Нет записей за этот период.',
  'reports.emptyDetail': 'Здесь появятся утверждённые проводки за выбранный период.',
```

- [ ] **Step 3: Add the Sidebar nav entry**

In `web/app/components/Sidebar.tsx`:

1. Extend the `key` and `shortKey` union types in the `NavItem` interface to include `'nav.reports'` and `'nav.short.reports'` respectively.
2. Add to `BASE_ITEMS` (so accountant/firm_admin see it), right after the `nav.journal` line:

```typescript
  { key: 'nav.reports',        shortKey: 'nav.short.reports',        href: '/reports',       icon: 'reports' },
```

3. Add to `OWNER_ITEMS` (owners want statements too), after the `nav.documents` line:

```typescript
  { key: 'nav.reports',       shortKey: 'nav.short.reports',       href: '/reports',       icon: 'reports' },
```

- [ ] **Step 4: Verify typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: no errors. (If any catalog is missing a key, TS fails here — that's the guard working.)

- [ ] **Step 5: Commit**

```bash
git add web/app/lib/i18n.ts web/app/components/NavIcon.tsx web/app/components/Sidebar.tsx
git commit -m "feat(web): reports nav entry, icon, and trilingual copy (M1)"
```

---

### Task 6: `/reports` page

**Files:**
- Create: `web/app/(cabinet)/reports/page.tsx`
- Create: `web/app/(cabinet)/reports/page.module.css`

**Interfaces:**
- Consumes: `/api/reports/profit-and-loss` and `/api/reports/balance-sheet`; `useMessages`, `LOCALE_FOR`, `SkeletonCard`, `ErrorState`, `EmptyState` (existing). The client id comes from the `client` search param (matching the journal page convention: URL param `client`, API query param `clientCompanyId`).
- Produces: a client component page with P&L | Balance Sheet tabs, a period picker, and sectioned money tables.

- [ ] **Step 1: Write the page**

Create `web/app/(cabinet)/reports/page.tsx`:

```tsx
'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import styles from './page.module.css';

interface StatementLine { code: string; name: string; amount: string; }
interface StatementSection { lines: StatementLine[]; subtotal: string; }
interface ProfitAndLoss { from: string | null; to: string | null; income: StatementSection; expense: StatementSection; netProfit: string; }
interface BalanceSheet {
  asOf: string; assets: StatementSection; liabilities: StatementSection; equity: StatementSection;
  currentPeriodResult: string; totalAssets: string; totalLiabilitiesAndEquity: string; balanced: boolean;
}

type Tab = 'pl' | 'bs';

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function firstOfMonthIso(): string { return todayIso().slice(0, 8) + '01'; }
function fmtMoney(v: string): string {
  return new Intl.NumberFormat('lv-LV', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));
}
function sectionEmpty(s: StatementSection): boolean { return s.lines.length === 0; }

function ReportsInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [tab, setTab] = useState<Tab>('pl');
  const [from, setFrom] = useState(firstOfMonthIso());
  const [to, setTo] = useState(todayIso());
  const [asOf, setAsOf] = useState(todayIso());

  const [pl, setPl] = useState<ProfitAndLoss | null>(null);
  const [bs, setBs] = useState<BalanceSheet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!clientCompanyId) return;
    setLoading(true); setError(null);
    try {
      const url = tab === 'pl'
        ? `/api/reports/profit-and-loss?clientCompanyId=${encodeURIComponent(clientCompanyId)}&from=${from}&to=${to}`
        : `/api/reports/balance-sheet?clientCompanyId=${encodeURIComponent(clientCompanyId)}&asOf=${asOf}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { report: ProfitAndLoss | BalanceSheet };
      if (tab === 'pl') { setPl(data.report as ProfitAndLoss); setBs(null); }
      else { setBs(data.report as BalanceSheet); setPl(null); }
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [clientCompanyId, tab, from, to, asOf, t]);

  useEffect(() => { load(); }, [load]);

  const setPreset = (preset: 'month' | 'quarter' | 'year') => {
    const now = new Date();
    const y = now.getFullYear();
    if (preset === 'month') { setFrom(firstOfMonthIso()); setTo(todayIso()); }
    else if (preset === 'quarter') {
      const q = Math.floor(now.getMonth() / 3);
      const startMonth = String(q * 3 + 1).padStart(2, '0');
      setFrom(`${y}-${startMonth}-01`); setTo(todayIso());
    } else { setFrom(`${y}-01-01`); setTo(todayIso()); }
  };

  const plIsLoss = useMemo(() => pl != null && Number(pl.netProfit) < 0, [pl]);

  const renderSection = (title: string, s: StatementSection) => (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <table className={styles.table}>
        <tbody>
          {s.lines.map((l, i) => (
            <tr key={`${l.code}-${i}`}>
              <td className={styles.code}>{l.code}</td>
              <td className={styles.name}>{l.name}</td>
              <td className={styles.amount}>{fmtMoney(l.amount)}</td>
            </tr>
          ))}
          <tr className={styles.subtotalRow}>
            <td /><td className={styles.name}>{title}</td>
            <td className={styles.amount}>{fmtMoney(s.subtotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('reports.title')}</h1>

        <div className={styles.tabs} role="tablist">
          <button role="tab" aria-selected={tab === 'pl'} className={tab === 'pl' ? styles.tabActive : styles.tab} onClick={() => setTab('pl')}>{t('reports.tab.pl')}</button>
          <button role="tab" aria-selected={tab === 'bs'} className={tab === 'bs' ? styles.tabActive : styles.tab} onClick={() => setTab('bs')}>{t('reports.tab.bs')}</button>
        </div>

        <div className={styles.controls}>
          {tab === 'pl' ? (
            <>
              <label className={styles.field}>{t('reports.from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className={styles.field}>{t('reports.to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
              <div className={styles.presets}>
                <button onClick={() => setPreset('month')}>{t('reports.preset.month')}</button>
                <button onClick={() => setPreset('quarter')}>{t('reports.preset.quarter')}</button>
                <button onClick={() => setPreset('year')}>{t('reports.preset.year')}</button>
              </div>
            </>
          ) : (
            <label className={styles.field}>{t('reports.asOf')}<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
          )}
        </div>

        {error && <ErrorState message={error} onRetry={load} />}
        {!error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}

        {!error && !loading && tab === 'pl' && pl && (
          sectionEmpty(pl.income) && sectionEmpty(pl.expense)
            ? <EmptyState message={t('reports.empty')} detail={t('reports.emptyDetail')} />
            : (
              <div className={styles.statement}>
                {renderSection(t('reports.income'), pl.income)}
                {renderSection(t('reports.expense'), pl.expense)}
                <div className={styles.grandTotal}>
                  <span>{plIsLoss ? t('reports.netLoss') : t('reports.netProfit')}</span>
                  <span className={styles.amount}>{fmtMoney(pl.netProfit)}</span>
                </div>
              </div>
            )
        )}

        {!error && !loading && tab === 'bs' && bs && (
          bs.assets.lines.length === 0 && bs.liabilities.lines.length === 0 && bs.equity.lines.length === 0
            ? <EmptyState message={t('reports.empty')} detail={t('reports.emptyDetail')} />
            : (
              <div className={styles.statement}>
                {renderSection(t('reports.assets'), bs.assets)}
                {renderSection(t('reports.liabilities'), bs.liabilities)}
                {renderSection(t('reports.equity'), bs.equity)}
                <div className={styles.grandTotal}>
                  <span>{t('reports.totalAssets')}</span><span className={styles.amount}>{fmtMoney(bs.totalAssets)}</span>
                </div>
                <div className={styles.grandTotal}>
                  <span>{t('reports.totalLiabEquity')}</span><span className={styles.amount}>{fmtMoney(bs.totalLiabilitiesAndEquity)}</span>
                </div>
                <div className={bs.balanced ? styles.balanced : styles.unbalanced}>
                  {bs.balanced ? t('reports.balanced') : t('reports.unbalanced')}
                </div>
              </div>
            )
        )}
      </main>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<SkeletonCard />}>
      <ReportsInner />
    </Suspense>
  );
}
```

- [ ] **Step 2: Write the stylesheet**

Create `web/app/(cabinet)/reports/page.module.css`:

```css
.page { display: flex; flex-direction: column; }
.main { width: 100%; max-width: 60rem; margin: 0 auto; padding: 1.5rem 1rem 4rem; }
.pageHeading { font-size: 1.5rem; font-weight: 650; margin: 0 0 1rem; }

.tabs { display: flex; gap: .5rem; border-bottom: 1px solid var(--border, #e5e7eb); margin-bottom: 1rem; }
.tab, .tabActive {
  appearance: none; background: none; border: none; cursor: pointer;
  padding: .5rem .75rem; font: inherit; color: var(--muted, #6b7280);
  border-bottom: 2px solid transparent;
}
.tabActive { color: var(--fg, #111827); border-bottom-color: currentColor; font-weight: 600; }

.controls { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; margin-bottom: 1.5rem; }
.field { display: flex; flex-direction: column; gap: .25rem; font-size: .8125rem; color: var(--muted, #6b7280); }
.field input { font: inherit; padding: .375rem .5rem; border: 1px solid var(--border, #e5e7eb); border-radius: .375rem; }
.presets { display: flex; gap: .375rem; }
.presets button {
  appearance: none; cursor: pointer; font: inherit; font-size: .8125rem;
  padding: .375rem .625rem; border: 1px solid var(--border, #e5e7eb);
  border-radius: .375rem; background: none; color: var(--fg, #111827);
}

.statement { display: flex; flex-direction: column; gap: 1.5rem; }
.section { }
.sectionTitle { font-size: .9375rem; font-weight: 600; margin: 0 0 .5rem; }
.table { width: 100%; border-collapse: collapse; }
.table td { padding: .3125rem .5rem; border-bottom: 1px solid var(--border-subtle, #f3f4f6); }
.code { color: var(--muted, #6b7280); font-variant-numeric: tabular-nums; width: 4.5rem; }
.name { }
.amount { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.subtotalRow td { font-weight: 600; border-top: 1px solid var(--border, #e5e7eb); border-bottom: none; }

.grandTotal {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: .625rem .5rem; font-weight: 700; font-size: 1rem;
  border-top: 2px solid var(--fg, #111827);
}

.balanced { color: var(--ok, #15803d); font-size: .875rem; padding: .25rem .5rem; }
.unbalanced { color: var(--danger, #b91c1c); font-weight: 600; font-size: .875rem; padding: .5rem; border: 1px solid currentColor; border-radius: .375rem; }

.skeletons { display: flex; flex-direction: column; gap: 1rem; }

@media (max-width: 640px) {
  .code { width: 3.5rem; }
  .controls { gap: .75rem; }
}
```

- [ ] **Step 3: Verify typecheck and build**

Run: `cd web && npx tsc --noEmit` → Expected: no errors.
Run: `cd web && npm run build` → Expected: build succeeds; `/reports` appears in the route list.

- [ ] **Step 4: Manual smoke test**

Ensure Postgres is up and the dev data is seeded (`npm run seed` from root if needed). Start the web dev server, sign in, select a client, and open `/reports`:
- P&L tab shows income/expense sections and a net figure for the current month; presets change the range and reload.
- Balance Sheet tab shows assets/liabilities/equity, a current-period-result line under equity, matching totals, and a green "Balanced" note.

Confirm the numbers reconcile with `/journal` for the same client.

- [ ] **Step 5: Commit**

```bash
git add "web/app/(cabinet)/reports/page.tsx" "web/app/(cabinet)/reports/page.module.css"
git commit -m "feat(web): /reports page — P&L and balance sheet with period picker (M1)"
```

---

### Task 7: Full verification + docs

**Files:**
- Modify: `HANDOFF.md` (mark M1 progress), `docs/ROADMAP-market-gaps.md` (M1 status → shipped, note M5/M14 now unblocked).

- [ ] **Step 1: Run the whole suite**

Run: `npm test` (root) → Expected: all pass, including the three new `tests/reports/*` files and the untouched ledger/tax tests.
Run: `npx tsc --noEmit` (root) and `cd web && npx tsc --noEmit` → Expected: no errors.

- [ ] **Step 2: Update the roadmap + handoff**

In `docs/ROADMAP-market-gaps.md`, change M1's status cell from `⛔` to `✅` and append a one-line note: "Shipped 2026-07-10 — `src/reports/` (P&L + Balance Sheet), `/reports` page. Cash-Flow still deferred. Unblocks M5, M14." In `HANDOFF.md`, add a short line under the reporting area noting P&L/BS shipped and Cash-Flow deferred.

- [ ] **Step 3: Commit**

```bash
git add HANDOFF.md docs/ROADMAP-market-gaps.md
git commit -m "docs: mark M1 financial statements (P&L + Balance Sheet) shipped"
```

---

## Self-Review notes

- **Spec coverage:** `accountBalances` + `trialBalance` refactor (Task 1) ✓; `profitAndLoss` (Task 2) ✓; `balanceSheet` with current-period result + balanced invariant (Task 3) ✓; API routes with defaults + 400 validation (Task 4) ✓; i18n all three catalogs + nav + icon (Task 5) ✓; `/reports` page with tabs/presets/empty/balanced signal (Task 6) ✓; testing (Tasks 1–3 domain unit tests, incl. date filtering, reversal net-out, empty ledger, invariant) ✓; out-of-scope items untouched ✓.
- **Type consistency:** `StatementLine`/`StatementSection` defined in `profit-and-loss.ts` and imported by `balance-sheet.ts` and the page; `DatedBalanceRow` from `balances.ts` consumed by both assemblers; API `{ report }` envelope matches the page's fetch parsing; `NavIconName` extended before use in Sidebar.
- **Convention match:** GET route shape, `client` URL param → `clientCompanyId` query param (journal precedent), i18n typing guard, stroked-SVG icon, `(tx, ctx, …)` domain signature, integer-cent money — all followed.
</content>

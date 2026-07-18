# Report Depth (M14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add General Ledger detail, account-transaction drill-down, and two-period comparatives to the reporting layer — all read-only over the existing ledger, no schema change.

**Architecture:** A thin read-layer over `src/ledger` + `src/reports` (spec Approach A): a flat line-lister (`listAccountLines`), a `generalLedger` that computes opening/running/closing balances from it, and a `comparative.ts` that merges two runs of the existing `profitAndLoss`/`balanceSheet` into variance rows. New API routes for GL + trial balance; the P&L/BS routes gain optional compare params (backward compatible). The `/reports` page gets General Ledger and Trial Balance tabs, compare-period controls on P&L/BS, and clickable statement/trial-balance lines that drill into the GL.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), PostgreSQL with RLS, `pg` PoolClient, vitest, Next.js 16 (web — read `node_modules/next/dist/docs/` before touching web routes per `web/AGENTS.md`).

## Global Constraints

- **Money is integer cents (`bigint`)** via `toCents`/`fromCents`/`sumCents` (`src/db/money.ts`). Never floats for money. **Exception:** `variancePct` is a display-only percentage, not money — computed with `Number` and `.toFixed(1)`, and is `null` (never a divide-by-zero) when the comparison base is zero.
- **Balances are debit-normal** everywhere in the ledger layer: `balance = SUM(debit) - SUM(credit)`. Statement `amount` values from `src/reports/` are already sign-flipped to natural presentation (credit-normal for income/liability/equity, debit-normal for expense/asset) — do not re-flip them.
- **No migration** — read-only over existing `accounts` / `journal_entries` / `journal_lines`.
- **Every query is tenant-scoped**: `client_company_id = $1` explicit predicate in addition to RLS (matches `accountBalances`).
- **Domain imports use `.js` specifiers** even for `.ts` files. Web routes import domain via `@domain/*`; client pages use `@/app/lib/*`.
- **Dates** are `YYYY-MM-DD`; routes validate with the existing `isValidIsoDate` helper; UTC-safe date math only (mirror `addDays` in `src/einvoice/inbound.ts`).
- **Report routes are read-only** — no role gate (matches the existing `/api/reports/*` routes), just `resolveTenantContext` + `withTenant` + error→401/403 mapping.
- **All new user-visible UI strings** are `t()` keys added to `web/app/lib/i18n.ts` for **LV/RU/EN** (LV/RU typed `Record<keyof typeof EN, string>`, so a missing translation fails the build). No hardcoded English.
- Tests: `npm test -- <path>` (targeted). Run ONE `npm test` at a time (the DB suite shares one Postgres and races if runs overlap). Web build: `cd web && npm run -s build`. Root typecheck: `npm run -s typecheck`.

---

### Task 1: Flat account-line lister — `listAccountLines`

**Files:**
- Modify: `src/ledger/query.ts` (add `AccountLineRow` + `listAccountLines`)
- Test: `tests/ledger/account-lines.test.ts`

**Interfaces:**
- Consumes: `PoolClient`, `TenantContext`.
- Produces:
  - `interface AccountLineRow { entryId: string; entryDate: string; memo: string; accountCode: string; accountName: string; debit: string; credit: string; description: string | null }`
  - `listAccountLines(tx, ctx, filter: { from: string; to: string; accountCodes?: string[] }): Promise<AccountLineRow[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/ledger/account-lines.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { listAccountLines } from '../../src/ledger/query.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seed() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await openPeriod(tx, ctx(t), { year: 2026, month: 4 });
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale A', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '300.00', credit: '0', description: 'in' },
      { accountCode: '6110', debit: '0', credit: '300.00', description: 'rev' },
    ]});
    await postEntry(tx, ctx(t), { date: '2026-04-05', memo: 'Sale B', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '50.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '50.00' },
    ]});
  });
  return t;
}

test('lists lines in a date range, ordered by account code then date', async () => {
  const t = await seed();
  const rows = await withTenant(ctx(t), (tx) => listAccountLines(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  expect(rows).toHaveLength(2); // only the March entry's two lines
  expect(rows.map((r) => r.accountCode)).toEqual(['2620', '6110']);
  expect(rows[0]).toMatchObject({ accountCode: '2620', debit: '300.00', credit: '0.00', memo: 'Sale A', description: 'in' });
  expect(rows[0]!.entryDate).toBe('2026-03-10');
});

test('filters by accountCodes', async () => {
  const t = await seed();
  const rows = await withTenant(ctx(t), (tx) => listAccountLines(tx, ctx(t), { from: '2026-01-01', to: '2026-12-31', accountCodes: ['6110'] }));
  expect(rows).toHaveLength(2); // both Sales lines across March + April
  expect(new Set(rows.map((r) => r.accountCode))).toEqual(new Set(['6110']));
});

test('empty accountCodes array is treated as no filter', async () => {
  const t = await seed();
  const rows = await withTenant(ctx(t), (tx) => listAccountLines(tx, ctx(t), { from: '2026-01-01', to: '2026-12-31', accountCodes: [] }));
  expect(rows.length).toBe(4);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/ledger/account-lines.test.ts`
Expected: FAIL — `listAccountLines` is not exported.

- [ ] **Step 3: Implement `listAccountLines` in `src/ledger/query.ts`**

Append to `src/ledger/query.ts` (keep the existing `listJournalEntries` untouched):

```ts
export interface AccountLineRow {
  entryId: string; entryDate: string; memo: string;
  accountCode: string; accountName: string;
  debit: string; credit: string; description: string | null;
}

/** Flat journal lines for the given accounts within [from,to], ordered by account, date, entry. */
export async function listAccountLines(
  tx: PoolClient,
  ctx: TenantContext,
  filter: { from: string; to: string; accountCodes?: string[] },
): Promise<AccountLineRow[]> {
  const codes = filter.accountCodes && filter.accountCodes.length ? filter.accountCodes : null;
  const res = await tx.query(
    `SELECT e.id AS "entryId", to_char(e.entry_date,'YYYY-MM-DD') AS "entryDate", e.memo,
            a.code AS "accountCode", a.name AS "accountName",
            l.debit::text AS debit, l.credit::text AS credit, l.description
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE l.client_company_id = $1
        AND e.entry_date BETWEEN $2::date AND $3::date
        AND ($4::text[] IS NULL OR a.code = ANY($4))
      ORDER BY a.code, e.entry_date, e.created_at, e.id`,
    [ctx.clientCompanyId, filter.from, filter.to, codes],
  );
  return res.rows;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/ledger/account-lines.test.ts`
Expected: PASS (3 tests). Note `debit`/`credit` render as `'300.00'`/`'0.00'` because the column is `numeric(18,2)` cast to text.

- [ ] **Step 5: Commit**

```bash
git add src/ledger/query.ts tests/ledger/account-lines.test.ts
git commit -m "feat(reports): listAccountLines — flat account-filtered ledger line lister (M14)"
```

---

### Task 2: General Ledger — `generalLedger`

**Files:**
- Create: `src/reports/general-ledger.ts`
- Test: `tests/reports/general-ledger.test.ts`

**Interfaces:**
- Consumes: `accountBalances` (`src/ledger/balances.js`), `listAccountLines` + `AccountLineRow` (Task 1), `toCents`/`fromCents` (`src/db/money.js`).
- Produces:
  - `interface GlLine { entryId: string; date: string; memo: string; description: string | null; debit: string; credit: string; balance: string }`
  - `interface GlAccount { code: string; name: string; opening: string; lines: GlLine[]; closing: string; totalDebit: string; totalCredit: string }`
  - `interface GeneralLedger { from: string; to: string; accounts: GlAccount[] }`
  - `generalLedger(tx, ctx, args: { from: string; to: string; accountCodes?: string[] }): Promise<GeneralLedger>`

- [ ] **Step 1: Write the failing test**

Create `tests/reports/general-ledger.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { generalLedger } from '../../src/reports/general-ledger.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seed() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    for (const m of [2, 3, 4]) await openPeriod(tx, ctx(t), { year: 2026, month: m });
    // February (before range): DR bank 100 / CR sales 100
    await postEntry(tx, ctx(t), { date: '2026-02-20', memo: 'Prior', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '100.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
    ]});
    // March (in range): two bank movements
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '300.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '300.00' },
    ]});
    await postEntry(tx, ctx(t), { date: '2026-03-15', memo: 'Refund', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '0', credit: '50.00' },
      { accountCode: '6110', debit: '50.00', credit: '0' },
    ]});
  });
  return t;
}

test('generalLedger computes opening, running, and closing per account', async () => {
  const t = await seed();
  const gl = await withTenant(ctx(t), (tx) => generalLedger(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31' }));
  const bank = gl.accounts.find((a) => a.code === '2620')!;
  expect(bank.opening).toBe('100.00');            // Feb debit-normal 100
  expect(bank.lines.map((l) => l.balance)).toEqual(['400.00', '350.00']); // +300 then -50
  expect(bank.closing).toBe('350.00');
  expect(bank.totalDebit).toBe('300.00');
  expect(bank.totalCredit).toBe('50.00');
  // accounts ordered by code
  expect(gl.accounts.map((a) => a.code)).toEqual(['2620', '6110']);
});

test('single-account filter returns only that account (drill-down)', async () => {
  const t = await seed();
  const gl = await withTenant(ctx(t), (tx) => generalLedger(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31', accountCodes: ['6110'] }));
  expect(gl.accounts).toHaveLength(1);
  expect(gl.accounts[0]!.code).toBe('6110');
  expect(gl.accounts[0]!.opening).toBe('-100.00'); // Feb credit-normal → debit-normal -100
  expect(gl.accounts[0]!.closing).toBe('-350.00'); // -100 -300 +50
});

test('a filtered account with no activity shows opening=closing, no lines', async () => {
  const t = await seed();
  const gl = await withTenant(ctx(t), (tx) => generalLedger(tx, ctx(t), { from: '2026-03-01', to: '2026-03-31', accountCodes: ['2620'] }));
  const acct = gl.accounts[0]!;
  // sanity: has lines here; instead check an empty window
  const empty = await withTenant(ctx(t), (tx) => generalLedger(tx, ctx(t), { from: '2026-05-01', to: '2026-05-31', accountCodes: ['2620'] }));
  expect(empty.accounts[0]!.lines).toHaveLength(0);
  expect(empty.accounts[0]!.opening).toBe(empty.accounts[0]!.closing);
  expect(acct.lines.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/reports/general-ledger.test.ts`
Expected: FAIL — module `src/reports/general-ledger.js` does not exist.

- [ ] **Step 3: Implement `src/reports/general-ledger.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { accountBalances } from '../ledger/balances.js';
import { listAccountLines } from '../ledger/query.js';
import { toCents, fromCents } from '../db/money.js';

export interface GlLine {
  entryId: string; date: string; memo: string; description: string | null;
  debit: string; credit: string; balance: string; // running debit-normal balance
}
export interface GlAccount {
  code: string; name: string;
  opening: string; lines: GlLine[]; closing: string; // debit-normal
  totalDebit: string; totalCredit: string;
}
export interface GeneralLedger { from: string; to: string; accounts: GlAccount[] }

/** UTC-safe YYYY-MM-DD minus one day. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function generalLedger(
  tx: PoolClient, ctx: TenantContext,
  args: { from: string; to: string; accountCodes?: string[] },
): Promise<GeneralLedger> {
  // Opening = all activity strictly before `from` (debit-normal), per account.
  const opening = await accountBalances(tx, ctx, { to: dayBefore(args.from) });
  const openingByCode = new Map(opening.map((r) => [r.code, r]));

  const lines = await listAccountLines(tx, ctx, args);
  const linesByCode = new Map<string, typeof lines>();
  for (const l of lines) {
    const arr = linesByCode.get(l.accountCode) ?? [];
    arr.push(l);
    linesByCode.set(l.accountCode, arr);
  }

  // Candidate accounts: explicit filter, else accounts with a non-zero opening OR in-range lines.
  const filter = args.accountCodes && args.accountCodes.length ? new Set(args.accountCodes) : null;
  const codes = new Set<string>();
  if (filter) {
    for (const c of filter) codes.add(c);
  } else {
    for (const r of opening) if (toCents(r.balance) !== 0n) codes.add(r.code);
    for (const c of linesByCode.keys()) codes.add(c);
  }

  const accounts: GlAccount[] = [...codes].sort().map((code) => {
    const meta = openingByCode.get(code);
    const openCents = meta ? toCents(meta.balance) : 0n;
    const acctLines = linesByCode.get(code) ?? [];
    let running = openCents;
    let totalDebit = 0n, totalCredit = 0n;
    const glLines: GlLine[] = acctLines.map((l) => {
      running += toCents(l.debit) - toCents(l.credit);
      totalDebit += toCents(l.debit);
      totalCredit += toCents(l.credit);
      return {
        entryId: l.entryId, date: l.entryDate, memo: l.memo, description: l.description,
        debit: l.debit, credit: l.credit, balance: fromCents(running),
      };
    });
    return {
      code, name: meta?.name ?? acctLines[0]?.accountName ?? code,
      opening: fromCents(openCents), lines: glLines, closing: fromCents(running),
      totalDebit: fromCents(totalDebit), totalCredit: fromCents(totalCredit),
    };
  });

  return { from: args.from, to: args.to, accounts };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/reports/general-ledger.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/reports/general-ledger.ts tests/reports/general-ledger.test.ts
git commit -m "feat(reports): generalLedger — opening/running/closing balances per account (M14)"
```

---

### Task 3: Comparatives — `comparative.ts`

**Files:**
- Create: `src/reports/comparative.ts`
- Test: `tests/reports/comparative.test.ts`

**Interfaces:**
- Consumes: `profitAndLoss` + `StatementSection`/`StatementLine` (`src/reports/profit-and-loss.js`), `balanceSheet` (`src/reports/balance-sheet.js`), `toCents`/`fromCents` (`src/db/money.js`).
- Produces:
  - `interface ComparativeLine { code: string; name: string; current: string; comparison: string; variance: string; variancePct: string | null }`
  - `interface ComparativeSection { lines: ComparativeLine[]; current: string; comparison: string; variance: string; variancePct: string | null }`
  - `interface ComparativeProfitAndLoss { current: {from:string;to:string}; comparison: {from:string;to:string}; income: ComparativeSection; expense: ComparativeSection; netProfit: ComparativeLine }`
  - `interface ComparativeBalanceSheet { asOf: string; comparisonAsOf: string; assets: ComparativeSection; liabilities: ComparativeSection; equity: ComparativeSection; currentPeriodResult: ComparativeLine; totalAssets: ComparativeLine; totalLiabilitiesAndEquity: ComparativeLine }`
  - `comparativeProfitAndLoss(tx, ctx, args: { current: {from,to}; comparison: {from,to} }): Promise<ComparativeProfitAndLoss>`
  - `comparativeBalanceSheet(tx, ctx, args: { asOf: string; comparisonAsOf: string }): Promise<ComparativeBalanceSheet>`

- [ ] **Step 1: Write the failing test**

Create `tests/reports/comparative.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { comparativeProfitAndLoss, comparativeBalanceSheet } from '../../src/reports/comparative.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seed() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    for (const m of [2, 3]) await openPeriod(tx, ctx(t), { year: 2026, month: m });
    // Feb: sales 100
    await postEntry(tx, ctx(t), { date: '2026-02-10', memo: 'Feb sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '100.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
    ]});
    // Mar: sales 300 + expense 60
    await postEntry(tx, ctx(t), { date: '2026-03-10', memo: 'Mar sale', currency: 'EUR', lines: [
      { accountCode: '2620', debit: '300.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '300.00' },
    ]});
    await postEntry(tx, ctx(t), { date: '2026-03-12', memo: 'Mar cost', currency: 'EUR', lines: [
      { accountCode: '7710', debit: '60.00', credit: '0' },
      { accountCode: '2620', debit: '0', credit: '60.00' },
    ]});
  });
  return t;
}

test('comparativeProfitAndLoss computes variance and % vs comparison', async () => {
  const t = await seed();
  const c = await withTenant(ctx(t), (tx) => comparativeProfitAndLoss(tx, ctx(t), {
    current: { from: '2026-03-01', to: '2026-03-31' },
    comparison: { from: '2026-02-01', to: '2026-02-28' },
  }));
  const sales = c.income.lines.find((l) => l.code === '6110')!;
  expect(sales).toMatchObject({ current: '300.00', comparison: '100.00', variance: '200.00', variancePct: '200.0' });
  // Expense present only in March → comparison side 0, pct null (zero base)
  const exp = c.expense.lines.find((l) => l.code === '7710')!;
  expect(exp).toMatchObject({ current: '60.00', comparison: '0.00', variance: '60.00', variancePct: null });
  expect(c.netProfit).toMatchObject({ current: '240.00', comparison: '100.00', variance: '140.00' });
});

test('comparativeBalanceSheet computes variance between two as-of dates', async () => {
  const t = await seed();
  const c = await withTenant(ctx(t), (tx) => comparativeBalanceSheet(tx, ctx(t), {
    asOf: '2026-03-31', comparisonAsOf: '2026-02-28',
  }));
  const bank = c.assets.lines.find((l) => l.code === '2620')!;
  expect(bank).toMatchObject({ current: '340.00', comparison: '100.00', variance: '240.00' }); // 100+300-60 vs 100
  expect(c.totalAssets.current).toBe('340.00');
  expect(c.totalAssets.comparison).toBe('100.00');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/reports/comparative.test.ts`
Expected: FAIL — module `src/reports/comparative.js` does not exist.

- [ ] **Step 3: Implement `src/reports/comparative.ts`**

```ts
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { profitAndLoss, type StatementSection, type StatementLine } from './profit-and-loss.js';
import { balanceSheet } from './balance-sheet.js';
import { toCents, fromCents } from '../db/money.js';

export interface ComparativeLine {
  code: string; name: string;
  current: string; comparison: string; variance: string; variancePct: string | null;
}
export interface ComparativeSection {
  lines: ComparativeLine[]; current: string; comparison: string; variance: string; variancePct: string | null;
}
export interface ComparativeProfitAndLoss {
  current: { from: string; to: string }; comparison: { from: string; to: string };
  income: ComparativeSection; expense: ComparativeSection; netProfit: ComparativeLine;
}
export interface ComparativeBalanceSheet {
  asOf: string; comparisonAsOf: string;
  assets: ComparativeSection; liabilities: ComparativeSection; equity: ComparativeSection;
  currentPeriodResult: ComparativeLine; totalAssets: ComparativeLine; totalLiabilitiesAndEquity: ComparativeLine;
}

/** Display-only % change; null when the comparison base is zero (never divide-by-zero). */
function pct(varianceCents: bigint, comparisonCents: bigint): string | null {
  if (comparisonCents === 0n) return null;
  const p = (Number(varianceCents) / Math.abs(Number(comparisonCents))) * 100;
  return p.toFixed(1);
}

function line(code: string, name: string, curCents: bigint, cmpCents: bigint): ComparativeLine {
  const v = curCents - cmpCents;
  return { code, name, current: fromCents(curCents), comparison: fromCents(cmpCents), variance: fromCents(v), variancePct: pct(v, cmpCents) };
}

/** Full-outer-join two statement sections by account code; account in only one period → other side 0. */
function mergeSections(cur: StatementSection, cmp: StatementSection): ComparativeSection {
  const curByCode = new Map<string, StatementLine>(cur.lines.map((l) => [l.code, l]));
  const cmpByCode = new Map<string, StatementLine>(cmp.lines.map((l) => [l.code, l]));
  const codes = [...new Set([...curByCode.keys(), ...cmpByCode.keys()])].sort();
  const lines = codes.map((code) => {
    const c = curByCode.get(code); const p = cmpByCode.get(code);
    return line(code, c?.name ?? p?.name ?? code, toCents(c?.amount ?? '0'), toCents(p?.amount ?? '0'));
  });
  const curSub = toCents(cur.subtotal); const cmpSub = toCents(cmp.subtotal);
  return { lines, current: fromCents(curSub), comparison: fromCents(cmpSub), variance: fromCents(curSub - cmpSub), variancePct: pct(curSub - cmpSub, cmpSub) };
}

export async function comparativeProfitAndLoss(
  tx: PoolClient, ctx: TenantContext,
  args: { current: { from: string; to: string }; comparison: { from: string; to: string } },
): Promise<ComparativeProfitAndLoss> {
  const cur = await profitAndLoss(tx, ctx, args.current);
  const cmp = await profitAndLoss(tx, ctx, args.comparison);
  return {
    current: args.current, comparison: args.comparison,
    income: mergeSections(cur.income, cmp.income),
    expense: mergeSections(cur.expense, cmp.expense),
    netProfit: line('', 'Net profit', toCents(cur.netProfit), toCents(cmp.netProfit)),
  };
}

export async function comparativeBalanceSheet(
  tx: PoolClient, ctx: TenantContext,
  args: { asOf: string; comparisonAsOf: string },
): Promise<ComparativeBalanceSheet> {
  const cur = await balanceSheet(tx, ctx, { asOf: args.asOf });
  const cmp = await balanceSheet(tx, ctx, { asOf: args.comparisonAsOf });
  return {
    asOf: args.asOf, comparisonAsOf: args.comparisonAsOf,
    assets: mergeSections(cur.assets, cmp.assets),
    liabilities: mergeSections(cur.liabilities, cmp.liabilities),
    equity: mergeSections(cur.equity, cmp.equity),
    currentPeriodResult: line('', 'Current-period result', toCents(cur.currentPeriodResult), toCents(cmp.currentPeriodResult)),
    totalAssets: line('', 'Total assets', toCents(cur.totalAssets), toCents(cmp.totalAssets)),
    totalLiabilitiesAndEquity: line('', 'Total liabilities & equity', toCents(cur.totalLiabilitiesAndEquity), toCents(cmp.totalLiabilitiesAndEquity)),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/reports/comparative.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/reports/comparative.ts tests/reports/comparative.test.ts
git commit -m "feat(reports): comparative P&L + Balance Sheet with variance (M14)"
```

---

### Task 4: API routes — general-ledger, trial-balance, and compare params

**Files:**
- Create: `web/app/api/reports/general-ledger/route.ts`
- Create: `web/app/api/reports/trial-balance/route.ts`
- Modify: `web/app/api/reports/profit-and-loss/route.ts` (optional compare params)
- Modify: `web/app/api/reports/balance-sheet/route.ts` (optional compare param)

**Interfaces:**
- Consumes: `generalLedger` (Task 2), `comparativeProfitAndLoss`/`comparativeBalanceSheet` (Task 3), `trialBalance` (`@domain/ledger/balances.js`), `profitAndLoss`/`balanceSheet` (existing).
- Produces: `GET /api/reports/general-ledger` → `{ report: GeneralLedger }`; `GET /api/reports/trial-balance` → `{ rows }`; P&L/BS routes return `{ report, comparative: boolean }`.

- [ ] **Step 1: Read the Next.js route docs + the existing report routes**

Run: `sed -n '1,45p' web/app/api/reports/profit-and-loss/route.ts && ls node_modules/next/dist/docs/01-app`
The existing report routes are the exact pattern to mirror (auth, `isValidIsoDate`, error→401/403). `web/AGENTS.md` warns this Next.js 16 differs from training data.

- [ ] **Step 2: Create `web/app/api/reports/general-ledger/route.ts`**

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { generalLedger } from '@domain/reports/general-ledger.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function firstOfMonthIso(): string { return todayIso().slice(0, 8) + '01'; }

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const from = req.nextUrl.searchParams.get('from') ?? firstOfMonthIso();
  const to = req.nextUrl.searchParams.get('to') ?? todayIso();
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    return NextResponse.json({ error: 'from/to must be YYYY-MM-DD' }, { status: 400 });
  }
  const account = req.nextUrl.searchParams.get('account');
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const report = await withTenant(ctx, (tx) =>
      generalLedger(tx, ctx, { from, to, ...(account ? { accountCodes: [account] } : {}) }));
    return NextResponse.json({ report }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 3: Create `web/app/api/reports/trial-balance/route.ts`**

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { accountBalances } from '@domain/ledger/balances.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const from = req.nextUrl.searchParams.get('from');
  const to = req.nextUrl.searchParams.get('to');
  if ((from && !isValidIsoDate(from)) || (to && !isValidIsoDate(to))) {
    return NextResponse.json({ error: 'from/to must be YYYY-MM-DD' }, { status: 400 });
  }
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const rows = await withTenant(ctx, (tx) =>
      accountBalances(tx, ctx, { ...(from ? { from } : {}), ...(to ? { to } : {}) }));
    return NextResponse.json({ rows }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}
```

- [ ] **Step 4: Extend `web/app/api/reports/profit-and-loss/route.ts`**

Add the comparative import and, inside `GET`, branch on optional compare params. Replace the `try` block body:

```ts
import { comparativeProfitAndLoss } from '@domain/reports/comparative.js';
// ...existing imports (profitAndLoss, etc.)...

  const compareFrom = req.nextUrl.searchParams.get('compareFrom');
  const compareTo = req.nextUrl.searchParams.get('compareTo');
  const wantCompare = compareFrom !== null && compareTo !== null;
  if (wantCompare && (!isValidIsoDate(compareFrom!) || !isValidIsoDate(compareTo!))) {
    return NextResponse.json({ error: 'compareFrom/compareTo must be YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    if (wantCompare) {
      const report = await withTenant(ctx, (tx) => comparativeProfitAndLoss(tx, ctx, {
        current: { from, to }, comparison: { from: compareFrom!, to: compareTo! },
      }));
      return NextResponse.json({ report, comparative: true }, { status: 200 });
    }
    const report = await withTenant(ctx, (tx) => profitAndLoss(tx, ctx, { from, to }));
    return NextResponse.json({ report, comparative: false }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
```

(The non-comparative response keeps its existing `{ report }` shape and just adds `comparative: false` — additive, safe for the current UI which reads `data.report`.)

- [ ] **Step 5: Extend `web/app/api/reports/balance-sheet/route.ts`**

```ts
import { comparativeBalanceSheet } from '@domain/reports/comparative.js';
// ...existing imports...

  const compareAsOf = req.nextUrl.searchParams.get('compareAsOf');
  if (compareAsOf !== null && !isValidIsoDate(compareAsOf)) {
    return NextResponse.json({ error: 'compareAsOf must be YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    if (compareAsOf !== null) {
      const report = await withTenant(ctx, (tx) => comparativeBalanceSheet(tx, ctx, { asOf, comparisonAsOf: compareAsOf }));
      return NextResponse.json({ report, comparative: true }, { status: 200 });
    }
    const report = await withTenant(ctx, (tx) => balanceSheet(tx, ctx, { asOf }));
    return NextResponse.json({ report, comparative: false }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
```

- [ ] **Step 6: Typecheck + build**

Run: `npm run -s typecheck && cd web && npm run -s build`
Expected: both clean (a pre-existing "multiple lockfiles" warning from the web build is expected — ignore only that).

- [ ] **Step 7: Commit**

```bash
git add web/app/api/reports/general-ledger/route.ts web/app/api/reports/trial-balance/route.ts web/app/api/reports/profit-and-loss/route.ts web/app/api/reports/balance-sheet/route.ts
git commit -m "feat(reports): GL + trial-balance routes; compare params on P&L/BS (M14)"
```

---

### Task 5: Reports page — GL & Trial Balance tabs, compare controls, drill-down links

**Files:**
- Modify: `web/app/(cabinet)/reports/page.tsx`
- Modify: `web/app/(cabinet)/reports/page.module.css` (columns for comparative/GL tables — reuse existing classes where possible)
- Modify: `web/app/lib/i18n.ts` (new keys, LV/RU/EN)

**Interfaces:**
- Consumes: `/api/reports/general-ledger`, `/api/reports/trial-balance`, and the extended `/api/reports/profit-and-loss` + `/balance-sheet` (Task 4). Response shapes from Tasks 2–3.

- [ ] **Step 1: Read the current reports page + i18n key style**

Run: `sed -n '1,140p' "web/app/(cabinet)/reports/page.tsx" && grep -n "reports.tab" web/app/lib/i18n.ts | head`
Understand the existing `Tab` type, `load()` URL switch, `renderSection`, and how `reports.*` keys are defined per language.

- [ ] **Step 2: Extend the `Tab` type and add TypeScript interfaces**

In `web/app/(cabinet)/reports/page.tsx`, change `type Tab = 'pl' | 'bs' | 'apaging';` to `type Tab = 'pl' | 'bs' | 'trial' | 'gl' | 'apaging';` and add interfaces mirroring the domain shapes:

```ts
interface GlLine { entryId: string; date: string; memo: string; description: string | null; debit: string; credit: string; balance: string; }
interface GlAccount { code: string; name: string; opening: string; lines: GlLine[]; closing: string; totalDebit: string; totalCredit: string; }
interface GeneralLedger { from: string; to: string; accounts: GlAccount[]; }
interface TrialRow { code: string; name: string; debit: string; credit: string; balance: string; }
interface ComparativeLine { code: string; name: string; current: string; comparison: string; variance: string; variancePct: string | null; }
interface ComparativeSection { lines: ComparativeLine[]; current: string; comparison: string; variance: string; variancePct: string | null; }
```

- [ ] **Step 3: Add state + fetch branches**

Add state: `gl`, `trial`, and comparative results, plus compare-period inputs (`compareFrom`/`compareTo` for P&L, `compareAsOf` for BS, each defaulting to empty = off) and a selected GL account (`glAccount`, default ''). In `load()`, extend the URL switch:
- `tab === 'gl'`: `/api/reports/general-ledger?clientCompanyId=..&from=..&to=..` + `&account=<glAccount>` when set → set `gl`.
- `tab === 'trial'`: `/api/reports/trial-balance?clientCompanyId=..` → set `trial` from `data.rows`.
- `tab === 'pl'`: append `&compareFrom=..&compareTo=..` when both set; read `data.comparative` to decide whether `data.report` is `ProfitAndLoss` or the comparative shape.
- `tab === 'bs'`: append `&compareAsOf=..` when set; branch on `data.comparative`.
Keep `apaging` unchanged. Add `glAccount`, `compareFrom`, `compareTo`, `compareAsOf` to the `useCallback` deps.

- [ ] **Step 4: Render the new tabs**

- Add tab buttons for `trial` and `gl` (between `bs` and `apaging`), styled like the existing ones, labelled `t('reports.tab.trial')` / `t('reports.tab.gl')`.
- **Trial Balance**: a table (code / name / debit / credit / balance); each row's code cell is a button/link that switches to the `gl` tab, sets `glAccount` to that code, and reloads (`?` navigation not required — set state). Use `fmtMoney`.
- **General Ledger**: an account `<select>` populated from a trial-balance fetch (reuse the `trial` state — fetch it when the GL tab needs the account list, or fetch trial on mount) with an "all accounts" option; period pickers (reuse `from`/`to`); then per-account blocks: a heading (`code — name`), an opening row, a line table (date / memo / description / debit / credit / running balance), and a closing row with `totalDebit`/`totalCredit`.
- **P&L / BS comparative**: when the compare inputs are set and `data.comparative` is true, render the section tables with four columns (current / comparison / variance / variance %); `variancePct === null` renders as `—`. When off, keep the existing single-column `renderSection`. Make each statement line's code a drill link into the GL tab (set `glAccount`, `from`/`to`, switch tab).

- [ ] **Step 5: Add i18n keys (LV/RU/EN)**

In `web/app/lib/i18n.ts`, add keys used above to the EN, LV, and RU blocks (parallel entries), e.g. `reports.tab.trial`, `reports.tab.gl`, `reports.gl.account`, `reports.gl.allAccounts`, `reports.gl.opening`, `reports.gl.closing`, `reports.gl.running`, `reports.col.debit`, `reports.col.credit`, `reports.compare`, `reports.compareTo`, `reports.col.current`, `reports.col.comparison`, `reports.col.variance`, `reports.col.variancePct`, and any table headers you introduce. LV/RU are typed `Record<keyof typeof EN, string>`, so a missing key fails the build — add all three.

- [ ] **Step 6: Typecheck + build (foreground, wait)**

Run: `cd web && npm run -s build`
Expected: exits 0, no type errors (ignore only the pre-existing "multiple lockfiles" warning). The new routes and page compile.

- [ ] **Step 7: Commit**

```bash
git add "web/app/(cabinet)/reports/page.tsx" "web/app/(cabinet)/reports/page.module.css" web/app/lib/i18n.ts
git commit -m "feat(reports): GL & Trial Balance tabs, compare controls, drill-down links (M14)"
```

---

### Task 6: Docs — roadmap + handoff

**Files:**
- Modify: `docs/ROADMAP-market-gaps.md` (M14 row)
- Modify: `HANDOFF.md` (progress note)

- [ ] **Step 1: Update the M14 roadmap row**

In `docs/ROADMAP-market-gaps.md`, change the M14 status from ⛔ to 🔶 with a dated note: General Ledger detail (`src/reports/general-ledger.ts`), account drill-down (single-account GL + clickable statement/trial-balance lines), and two-period comparatives (`src/reports/comparative.ts`) shipped; **PDF/Excel/CSV export still deferred** to its own follow-on spec. Reference `docs/superpowers/specs/2026-07-18-report-depth-design.md`.

- [ ] **Step 2: Update HANDOFF**

In `HANDOFF.md`, add an M14 progress bullet under the market-gaps block noting the three data-depth features shipped and that export is the remaining M14 slice.

- [ ] **Step 3: Commit**

```bash
git add docs/ROADMAP-market-gaps.md HANDOFF.md
git commit -m "docs: M14 report depth (data-layer) shipped — roadmap + handoff (M14)"
```

---

## Self-Review

**1. Spec coverage:**
- General Ledger detail (opening/running/closing) → Task 2. ✅
- Account drill-down (single-account GL + clickable statement/trial rows) → Tasks 2 (single-account), 4 (route), 5 (links). ✅
- Two-period comparatives with variance + % → Task 3 (domain), 4 (routes), 5 (UI). ✅
- Trial Balance surface (parent for drill-down) → Task 4 (route), 5 (tab). ✅
- Flat line lister → Task 1. ✅
- No migration (read-only) → honored throughout. ✅
- variancePct null-safe on zero base → Task 3 `pct()` + test. ✅
- Backward-compatible P&L/BS routes → Task 4 (additive `comparative` flag, single-period path unchanged). ✅
- i18n LV/RU/EN for new strings → Task 5 Step 5. ✅
- Export / N-column trend / fiscal-year resets explicitly out of scope → not built. ✅

**2. Placeholder scan:** Domain Tasks 1–3 carry complete code + tests. API Task 4 carries full route code. UI Task 5 is described at the concrete-change level (state, fetch branches, render blocks, exact i18n keys) rather than full React — consistent with how the M7 UI tasks were specified and verified (web build + the domain tests underneath); no "TBD"/"handle edge cases". No `variancePct` divide-by-zero (guarded + tested).

**3. Type consistency:** `AccountLineRow` (Task 1) consumed by `generalLedger` (Task 2). `GeneralLedger`/`GlAccount`/`GlLine` (Task 2) consumed by Tasks 4–5. `ComparativeSection`/`ComparativeLine` and the two comparative functions (Task 3) consumed by Tasks 4–5. Route response shapes (`{ report }`, `{ rows }`, `{ report, comparative }`) consumed by Task 5's fetch branches. `accountBalances`/`trialBalance` signatures match their existing definitions. Debit-normal balance convention consistent across Tasks 1–3.

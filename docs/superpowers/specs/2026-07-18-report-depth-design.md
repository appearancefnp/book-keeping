# Report Depth (M14) — Design

Date: 2026-07-18. Design for **M14 — Report depth** from `docs/ROADMAP-market-gaps.md`
(Tier 3). The app has P&L, Balance Sheet, AP aging (M1/M2) and a journal browser, but no
General Ledger detail, no way to drill from a statement figure into the transactions behind
it, and no period comparison. This adds the read-layer depth accountants expect, riding on
M1's `src/reports/` and the existing ledger — no schema changes.

**Scope decision (agreed):** **data depth first** — General Ledger detail, account-transaction
drill-down, and period-over-period comparatives. **Export (CSV/Excel/PDF) is deferred to its
own follow-on spec** (it is a cross-cutting concern best designed once, against the finished
report set).

**Goal:** an accountant can (1) open a full General Ledger for a period — every account, with
opening balance, each line, a running balance, and closing balance; (2) click any P&L /
Balance Sheet / trial-balance figure to see the transactions composing it; and (3) view P&L
and Balance Sheet with a comparison period beside the current one, with absolute and %
variance.

---

## Decisions (agreed during brainstorming)

1. **Data depth first**, export deferred.
2. **Comparatives = two periods + variance.** Current period vs one freely-chosen comparison
   period, with an absolute variance column and a % change column. Not N-column trend
   (that's closer to M16).
3. **Drill-down = standalone General Ledger report AND clickable statement lines.** A
   standalone GL report (account picker + period) *and* every P&L / Balance Sheet /
   trial-balance row links straight into that account's ledger for the period.

---

## Context — what already exists (reused, not rebuilt)

- **`accountBalances(tx, ctx, { from?, to? })`** (`src/ledger/balances.ts`) — per-account
  debit/credit/**debit-normal balance** (`SUM(debit) - SUM(credit)`), optionally date-bounded,
  includes zero-line accounts, ordered by code. `trialBalance()` is `accountBalances({})`.
- **`profitAndLoss(tx, ctx, { from, to })`** and **`balanceSheet(tx, ctx, { asOf })`**
  (`src/reports/`) — return `StatementSection { lines: StatementLine[]; subtotal }` where
  `StatementLine = { code, name, amount }` (amount already sign-flipped to natural
  presentation: credit-normal for income/liability/equity, debit-normal for expense/asset).
- **`listJournalEntries(tx, ctx, { limit })`** (`src/ledger/query.ts`) — grouped entries,
  limit-only, no date/account filter. The GL needs a **flat, date-and-account-filtered**
  line list instead, so we add a sibling function rather than overload this one.
- **`/reports` page** (`web/app/(cabinet)/reports/page.tsx`) — client component, tabs
  `pl | bs | apaging`, trilingual, period pickers. New tabs slot in here.
- **Report routes** (`web/app/api/reports/{profit-and-loss,balance-sheet,ap-aging}/route.ts`)
  — the P&L route validates `from`/`to` (`isValidIsoDate`), maps errors to 401/403.
- **Money/format** — integer cents (`toCents`/`fromCents`/`sumCents`); UI `formatCents`/
  `formatDecimal` and the page's `fmtMoney` (lv-LV grouping).

**No migration** — everything is read-only over existing `accounts` / `journal_entries` /
`journal_lines`.

---

## Domain (`src/`)

### 1. Flat account-line lister — `src/ledger/query.ts`

Add:

```ts
export interface AccountLineRow {
  entryId: string; entryDate: string; memo: string;
  accountCode: string; accountName: string;
  debit: string; credit: string; description: string | null;
}

export async function listAccountLines(
  tx: PoolClient, ctx: TenantContext,
  filter: { from: string; to: string; accountCodes?: string[] },
): Promise<AccountLineRow[]>
```

Selects `journal_lines` joined to `journal_entries` + `accounts`, `client_company_id = $1`,
`entry_date BETWEEN from AND to`, and (when `accountCodes` is given and non-empty)
`a.code = ANY($4)`. Ordered by `a.code, e.entry_date, e.created_at, e.id`. Debit/credit as
`::text`. RLS scopes rows; explicit tenant predicate as defense-in-depth (matches
`accountBalances`).

### 2. General Ledger — `src/reports/general-ledger.ts`

```ts
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

export async function generalLedger(
  tx: PoolClient, ctx: TenantContext,
  args: { from: string; to: string; accountCodes?: string[] },
): Promise<GeneralLedger>
```

Algorithm:
- **Opening balances**: `accountBalances(tx, ctx, { to: dayBefore(args.from) })` → map
  `code → debit-normal balance` (all activity strictly before `from`). `dayBefore` is a
  UTC-safe `YYYY-MM-DD` decrement (mirror `addDays` in `src/einvoice/inbound.ts`).
- **In-range lines**: `listAccountLines(tx, ctx, args)`, grouped by `code`.
- Per account (the union of accounts that have an opening balance **or** in-range lines,
  restricted to `accountCodes` when given): opening = mapped opening (or `0.00`); walk lines
  in order accumulating `running += toCents(debit) - toCents(credit)`, emitting each line's
  running `balance`; closing = opening + Σmovements; `totalDebit`/`totalCredit` = Σ of the
  columns. All money via `toCents`/`fromCents`. Accounts ordered by code; lines already ordered.
- A **single-account** call (`accountCodes: [code]`) is exactly the drill-down payload.

**Opening-balance semantics (documented nuance):** opening is the raw cumulative
debit-normal balance of *all* prior activity. For income/expense (P&L) accounts this is
cumulative-since-inception, not reset at fiscal-year start. Fiscal-year opening resets are
**out of scope** (noted below) — a standard GL detail report shows brought-forward balances,
and closing period logic is a separate concern (`src/ledger/periods.ts`).

### 3. Comparatives — `src/reports/comparative.ts`

Merge two already-built statements by account code; keep section structure.

```ts
export interface ComparativeLine {
  code: string; name: string;
  current: string; comparison: string; variance: string; variancePct: string | null;
}
export interface ComparativeSection { lines: ComparativeLine[]; current: string; comparison: string; variance: string; variancePct: string | null }

export async function comparativeProfitAndLoss(
  tx, ctx, args: { current: { from: string; to: string }; comparison: { from: string; to: string } },
): Promise<{ income: ComparativeSection; expense: ComparativeSection; netProfit: ComparativeLine }>

export async function comparativeBalanceSheet(
  tx, ctx, args: { asOf: string; comparisonAsOf: string },
): Promise<{ assets: ComparativeSection; liabilities: ComparativeSection; equity: ComparativeSection; currentPeriodResult: ComparativeLine; totals: {...} }>
```

- Calls `profitAndLoss` / `balanceSheet` once per period, then a shared `mergeSections(cur,
  cmp)` helper: full-outer-join lines by `code` (account present in only one period → the
  other side `0.00`), `variance = current - comparison` (in cents, presentation sign),
  `variancePct = comparison === 0 ? null : round(variance / |comparison| * 100)` — **null when
  the comparison base is zero** (UI renders `—`, never divide-by-zero). Section-level totals
  computed the same way from the two subtotals.
- Existing `profitAndLoss` / `balanceSheet` signatures and behavior are **unchanged**.

---

## API routes

- **`GET /api/reports/general-ledger`** — `clientCompanyId`, `from`, `to`, optional `account`
  (single code; omitted ⇒ all accounts). Validates dates with the existing `isValidIsoDate`;
  returns `{ report: GeneralLedger }`. Same auth/tenant/error pattern as the P&L route.
- **`GET /api/reports/trial-balance`** — `clientCompanyId` (+ optional `from`/`to`); returns
  `{ rows: TrialBalanceRow[] }` from `trialBalance()` / `accountBalances`. This is the parent
  surface the drill-down links from.
- **`GET /api/reports/profit-and-loss`** — **extend, backward-compatible**: optional
  `compareFrom` + `compareTo`. When both present and valid ⇒ return
  `{ report: <comparative> , comparative: true }`; otherwise the existing single-period
  `{ report }` unchanged.
- **`GET /api/reports/balance-sheet`** — **extend**: optional `compareAsOf` ⇒ comparative;
  else unchanged.

All routes: `resolveTenantContext` → `withTenant`, date validation, error→401/403 mapping,
mirroring the existing report routes. Read-only (no role gate needed; matches current report routes).

---

## UI (`web/app/(cabinet)/reports/page.tsx`)

Tabs become `pl | bs | trial | gl | apaging`.

- **General Ledger tab** — account picker + period range. The account `<select>` is
  populated from `GET /api/reports/trial-balance` (its rows already carry every account's
  `code` + `name`); an empty selection means "all accounts". Renders per-account groups: an opening-balance
  row, each line (date, memo/description, debit, credit, running balance), and a
  closing-balance row with column totals. Reads `?account=&from=&to=` from the URL so
  drill-down links land pre-filtered and pre-loaded.
- **Trial Balance tab** — code / name / debit / credit / balance; each row links to the GL
  tab filtered to that account for the current period (`?tab=gl&account=<code>&from=&to=`).
- **P&L / Balance Sheet tabs** — add an optional "compare to" control (a comparison range for
  P&L; a comparison as-of date for BS). Unset ⇒ identical to today. Set ⇒ render
  `current | comparison | variance | variance %` columns (variance % shows `—` when null).
  Every statement line links into the GL tab for that account + the current period.
- All new visible strings are `t()` keys in `web/app/lib/i18n.ts` for **LV/RU/EN** (typed
  `Record<keyof typeof EN, string>`, so a missing translation fails the build). Money via the
  page's existing `fmtMoney`/`formatCents` conventions. **Read `node_modules/next/dist/docs/`
  before touching web code** (`web/AGENTS.md` — Next.js 16 breaking changes).

---

## Testing

Follows the house convention (no migration; domain + tests + API route + page):

- `listAccountLines` — period + account filtering; ordering (code, date, entry); tenant scoping.
- `generalLedger` — opening excludes in-range/after lines; running balance accumulates
  debit−credit; closing = opening + Σmovements; column totals; multi-account grouping;
  single-account (drill-down) shape; empty-range yields opening=closing with no lines.
- `comparativeProfitAndLoss` / `comparativeBalanceSheet` — variance = current − comparison;
  `variancePct` null on zero comparison base (no divide-by-zero); account in only one period
  shows the other side as `0.00`; section totals reconcile.
- API: GL and trial-balance happy paths + date validation (400); P&L/BS routes stay
  backward-compatible with no compare params, and return the comparative shape with them.

---

## Out of scope (own follow-on specs)

- **CSV / Excel / PDF export** of any report — deferred per the scope decision; the natural
  next M14 slice, designed once against these finished reports.
- **N-column trend comparatives** (multi-period across the page) → closer to M16.
- **Fiscal-year opening-balance resets** for P&L accounts — the GL shows raw cumulative
  brought-forward balances; year-end close logic is a separate concern.
- **Dimensional filtering** (project/cost-center) → M15.

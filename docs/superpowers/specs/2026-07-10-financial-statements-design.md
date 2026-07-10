# Financial statements (M1) — design

Date: 2026-07-10. Roadmap item **M1** in `docs/ROADMAP-market-gaps.md` — the
highest-value core gap and first in the suggested unblocked sequence
(M1 → M2 → M3). This spec covers a **Profit & Loss (Income Statement)** and a
**Balance Sheet**, on demand for any period, rendered on a new `/reports`
screen over the existing tested ledger.

The Cash-Flow statement is deliberately **out of scope** here (see below).

## Goal

Give owners and accountants the two management statements every commercial
bookkeeping tool ships on a button — P&L and Balance Sheet — computed live from
the append-only ledger for any date range / as-of date, without waiting for
year-end closing. This is distinct from the statutory **annual report**
(`HANDOFF §5`, spec §6.8), which involves closing entries and retained-earnings
rollover; those do not exist yet and are not required for this feature.

## Substrate (what already exists)

- `accounts` — `{ id, code, name, type }`, `type ∈ {asset, liability, equity,
  income, expense}`. **`type` is the authoritative classification** for
  statements: tenants create arbitrary codes via templates/onboarding, so code
  prefixes are not reliable for correctness (they follow the LV standard
  numbering — class 2 current assets, 5 creditors, 6 income, 7 expenses — only
  by convention). Code is used for ordering and optional display grouping only.
- `journal_entries` — `{ entry_date (date), memo, currency, reverses_entry_id }`.
  Append-only (DB triggers); corrections are reversals, not edits, so reversed
  entries net to zero automatically.
- `journal_lines` — `{ account_id, debit numeric(18,2), credit numeric(18,2) }`.
- `src/ledger/balances.ts` `trialBalance(tx, ctx)` — the only report today; sums
  debit/credit per account with no date filter.
- `src/db/money.ts` — integer-cent money (`toCents`/`fromCents`/`sumCents`).
  All report money flows through this; never floats.
- Tenancy: domain functions take `(tx, ctx, ...)` and run inside
  `withTenant(ctx, ...)`; RLS enforced at the DB layer.

## Architecture

**Approach:** reporting SQL mirroring `trialBalance()`, with a single shared
"balances over a date range" primitive that both statement assemblers consume as
pure transforms. Rejected alternatives: materialized report snapshots (premature
— ledger is small and append-only; YAGNI); duplicating the balance query in each
statement (keeps SQL in two places, drift risk).

### Domain — `src/reports/`

**`accountBalances` — shared primitive, in `src/ledger/balances.ts`**

Lives alongside `trialBalance` in the ledger module (it is a ledger-level
primitive, not report-specific), so the dependency runs `reports → ledger` and
`trialBalance` can reuse it without a circular import.

```
interface DatedBalanceRow {
  code: string; name: string; type: AccountType;
  debit: string; credit: string; balance: string;   // 2-dp numeric text, like trialBalance
}
accountBalances(tx, ctx, { from?, to? }): Promise<DatedBalanceRow[]>
```

- One SQL aggregate over `journal_lines` joined to `journal_entries` (for
  `entry_date`) and `accounts` (for `code/name/type`), grouped by account.
- `from`/`to` are inclusive `YYYY-MM-DD` bounds on `entry_date`; either may be
  omitted (open-ended). Omitting both == `trialBalance()`.
- `balance = SUM(debit) - SUM(credit)` (debit-normal sign).
- **Refactor:** `trialBalance()` in `src/ledger/balances.ts` is reimplemented to
  call `accountBalances(tx, ctx, {})` so there is one query. Its existing return
  shape and callers are preserved (no behavior change; existing tests must still
  pass).

**`profit-and-loss.ts`**

```
interface StatementLine { code: string; name: string; amount: string; }   // signed cents text
interface StatementSection { title: 'income'|'expense'; lines: StatementLine[]; subtotal: string; }
interface ProfitAndLoss {
  from: string | null; to: string | null;
  income: StatementSection;    // credit-normal: amount = credit - debit
  expense: StatementSection;   // debit-normal:  amount = debit - credit
  netProfit: string;           // income.subtotal - expense.subtotal
}
profitAndLoss(tx, ctx, { from, to }): Promise<ProfitAndLoss>
```

- Filters `accountBalances` rows to `type === 'income'` and `type === 'expense'`.
- Income lines presented as credit-normal (positive = revenue); expense lines as
  debit-normal (positive = cost). Zero-balance accounts are omitted from lines.
- All arithmetic in integer cents via `money.ts`; output as `fromCents` strings.

**`balance-sheet.ts`**

```
interface BalanceSheet {
  asOf: string;
  assets: StatementSection;       // debit-normal
  liabilities: StatementSection;  // credit-normal
  equity: StatementSection;       // credit-normal, INCLUDING the current-period result line
  currentPeriodResult: string;    // = all income - all expenses up to asOf (the extra equity line)
  totalAssets: string;
  totalLiabilitiesAndEquity: string;
  balanced: boolean;              // totalAssets === totalLiabilitiesAndEquity
}
balanceSheet(tx, ctx, { asOf }): Promise<BalanceSheet>
```

- Calls `accountBalances(tx, ctx, { to: asOf })` (cumulative to the as-of date).
- Assets = asset-type balances (debit-normal). Liabilities = liability-type
  (credit-normal). Equity = equity-type (credit-normal) **plus** a synthetic
  `currentPeriodResult` line = (Σ income − Σ expense) to `asOf`.
- **Invariant:** because double-entry guarantees Σdebits = Σcredits across all
  lines, `totalAssets == totalLiabilities + totalEquity` (with the current
  result folded into equity). `balanced` asserts this; it should always be true
  for a consistent ledger and is surfaced in the UI as a data-integrity signal.

### Web API — `web/app/api/reports/`

Copy an existing GET route; `getSessionToken()` →
`resolveTenantContext(token, clientCompanyId, nowUnix())` → domain call inside
`withTenant`. Read-only; keep the 401/403 error mapping.

- `GET /api/reports/profit-and-loss?from=YYYY-MM-DD&to=YYYY-MM-DD`
  — defaults: `from` = first day of current month, `to` = today.
- `GET /api/reports/balance-sheet?asOf=YYYY-MM-DD`
  — default: `asOf` = today.

Query params validated with zod (`YYYY-MM-DD` shape); invalid dates → 400.

### Web page — `/reports` (`web/app/(cabinet)/reports/`)

- Two statement tabs: **P&L** | **Balance Sheet**.
- Period picker: P&L shows from/to; BS shows a single as-of date. Quick presets
  (this month, this quarter, this year / as-of today). Sensible defaults match
  the API defaults.
- Statements rendered as sectioned tables reusing the tabular-numeral,
  right-aligned money styling from `PostingLines`. Section subtotals bold; final
  total (Net profit / Balance total) emphasized. Zero-balance accounts hidden.
- Balance Sheet shows Assets vs Liabilities+Equity totals with a calm
  "balanced" check; a divergence renders a loud warning (real integrity signal,
  not expected in normal operation).
- Empty state when the period has no entries.
- Sidebar nav entry + `NavIcon` (inline stroked `currentColor` SVG, ~1.5px).
  Gated to accountant/owner roles in the Sidebar, matching existing cabinet
  screens. (Server-side role gating on routes is a known cross-cutting gap,
  `HANDOFF` — not introduced or regressed here; these are read-only routes.)

### i18n

Every user-facing string added to **all three** catalogs (EN/LV/RU) in
`web/app/lib/i18n.ts` (typed `Record<keyof typeof EN, string>` — TS fails the
build if a key is missing). Dates formatted via `LOCALE_FOR[lang]`.

## Testing

House order: (no migration) → domain → tests → API → page. Backend unit tests in
`tests/reports/` over a seeded mini-ledger:

- P&L: income subtotal, expense subtotal, net profit; zero-balance accounts
  omitted; income presented credit-normal and expense debit-normal.
- Balance Sheet: asset/liability/equity classification; the
  **Assets = Liabilities + Equity invariant** (`balanced === true`); the
  current-period-result equity line equals P&L net for the same window.
- Date filtering: entries outside `[from, to]` excluded from P&L; BS respects
  `asOf` (later entries excluded); open-ended bounds behave.
- Reversals net to zero (a posting + its reversal contribute nothing).
- Empty ledger → all zeros, `balanced === true`.
- `trialBalance()` refactor: existing ledger tests still pass unchanged.

Run `npm test` (root) and `npx tsc --noEmit` in both root and `web/`.

## Out of scope (deferred)

- **Cash-Flow statement** — needs each account classified by activity
  (operating/investing/financing), which the data model does not capture. Its
  own design (new classification column or code heuristic + direct/indirect
  method).
- **PDF/CSV/Excel export** and **period-over-period comparatives** — roadmap
  **M14** (report depth); rides on this layer next.
- **Aged receivables/payables** — roadmap **M5**; builds on this report layer.
- **Statutory annual report + period closing / retained-earnings rollover** —
  `HANDOFF §5` (spec §6.8); separate feature. This spec intentionally computes
  the current-period result on the fly instead.
- **Sub-classification** (current vs non-current assets, COGS vs operating
  expense) — requires reliable code taxonomy or a sub-type column; grouping is
  by `type` only for now, ordered by code.

## Files (anticipated)

New:
- `src/reports/profit-and-loss.ts`
- `src/reports/balance-sheet.ts`
- `tests/reports/profit-and-loss.test.ts`
- `tests/reports/balance-sheet.test.ts`
- `web/app/api/reports/profit-and-loss/route.ts`
- `web/app/api/reports/balance-sheet/route.ts`
- `web/app/(cabinet)/reports/page.tsx` (+ any client components)

Modified:
- `src/ledger/balances.ts` — add `accountBalances`; `trialBalance` reuses it.
- `web/app/lib/i18n.ts` — EN/LV/RU strings.
- Sidebar/nav — `/reports` entry + icon.
</content>
</invoke>

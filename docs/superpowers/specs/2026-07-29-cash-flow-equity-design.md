# Cash-Flow Statement + Statement of Equity (M1 completion) — design

Date: 2026-07-29. Closes the last Tier-1 credibility-floor gap in
`docs/ROADMAP-market-gaps.md` (M1 was 🔶 — P&L + Balance Sheet shipped 2026-07-10,
Cash-Flow + Statement of Equity ⛔). Read-only over the append-only ledger, **no
migration**, following the established `src/reports/` assembler pattern.

## What shipped

- `src/reports/cash-flow.ts` — `cashFlow(tx, ctx, {from, to})` → indirect-method
  cash-flow statement: net profit → working-capital adjustments (operating),
  investing, financing, net change in cash, opening/closing cash, `reconciles`.
- `src/reports/equity.ts` — `statementOfEquity(tx, ctx, {from, to})` → per equity
  account opening/movement/closing + accumulated result line + totals, `balanced`.
- `tabular.ts` `cashFlowTable` / `statementOfEquityTable` (feeds the existing
  CSV/Excel/PDF export machinery unchanged), `ReportLabels` extended.
- Routes `GET /api/reports/cash-flow` and `GET /api/reports/statement-of-equity`
  (period statements, `from`/`to`), plus `cashflow`/`equity` cases in
  `GET /api/reports/export`.
- `/reports` page: two new tabs with a from/to + preset picker, export bar, and a
  reconciliation/balanced indicator. i18n keys added to LV/RU/EN.

## The one real design decision: activity classification

A cash-flow statement must (a) identify which accounts are **cash** and (b) split
every movement into **Operating / Investing / Financing**. Neither can come from
`accounts.type` — all cash is `asset`, and `type` has no O/I/F axis. This is the
"activity classification" the roadmap deferred.

**Decision (Karlis, 2026-07-29): config code-map, no migration.** Cash and the
long-term buckets are keyed off configurable account-code prefixes defaulting to
the Latvian unified chart of accounts; equity accounts are always financing (by
`type` — robust, no prefix). Env-overridable:

| Env var                    | Default      | Meaning                              |
|----------------------------|--------------|--------------------------------------|
| `CASHFLOW_CASH_CODES`      | `26`         | naudas līdzekļi (kase, banka, ceļā)  |
| `CASHFLOW_INVESTING_CODES` | `11,12,13`   | ilgtermiņa ieguldījumi (asset only)  |
| `CASHFLOW_FINANCING_CODES` | `51,52`      | aizņēmumi / borrowings (liab. only)  |

This **deliberately extends the existing hard-coded account-mapping debt** (see
`src/bankfeed/sync.ts`, `HANDOFF.md` §M2 follow-ups) rather than resolving it — a
per-client account-mapping settings screen is still owed. It ships M1 today with
no schema change. (Rejected alternatives: an `accounts.cash_flow_activity` column
+ migration + settings UI — heavier, drags in the deferred mapping screen; and a
net-cash-change-only report with no O/I/F split — undersells vs Xero/QBO.)

## Why it always reconciles

Every journal entry is balanced, so over any period the debit-normal movements of
**all** accounts sum to zero. Therefore the net change in cash equals the negated
sum of all non-cash movements, and Operating + Investing + Financing ties to the
change in cash **by construction, regardless of the classification** — only the
split *between* the three buckets depends on the code-map. `cashFlow.reconciles`
re-checks `openingCash + netChange === closingCash` against an independent
opening-cash query; `statementOfEquity.balanced` checks
`openingTotal + movementTotal === closingTotal`.

### Known behaviour (documented, not a bug)

- **Depreciation presentation** depends on where accumulated-depreciation codes
  fall in the map. Cash effect is always nil (non-cash), and the statement always
  reconciles; only whether the add-back shows inside operating vs. investing
  depends on the mapping. Revisit with the per-client account-mapping screen.
- Accounts under no configured prefix (and not equity) fall to **operating** — the
  correct default for current working-capital accounts (receivables, payables,
  VAT, inventory).

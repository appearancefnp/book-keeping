# Report Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export every `/reports` report (P&L, Balance Sheet, General Ledger, Trial Balance, AP aging) to CSV, Excel (.xlsx), and printable-HTML PDF — exporting exactly what is on screen, in the user's language.

**Architecture:** A format-neutral `ReportTable` model (spec Approach A). Label-agnostic domain serializers turn each report result into a `ReportTable` (they receive a translated `ReportLabels` object, so trilingual strings stay only in the web i18n). Three encoders consume the table: CSV (pure, `src/`), printable HTML (pure, `src/`, mirroring `invoice-html.ts`), and xlsx (ExcelJS, `web/`, runs in the Node route). One export API route dispatches on `report` + `format`; the reports page gets per-tab export links.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, Next.js 16 (web), ExcelJS (new web dependency).

## Global Constraints

- **No migration** — read-only over the existing report domain functions.
- **Money** stays as the decimal strings the report functions already return; `ReportTable` cells are plain strings. Do not re-parse or re-round.
- **Domain (`src/`) stays dependency-free** — CSV and printable-HTML encoders use only existing utilities (`escapeXml` from `../xml/escape.js`). ExcelJS is a **web-only** dependency (`web/package.json`), used solely in `web/app/lib/report-xlsx.ts`.
- **Domain serializers are label-agnostic**: they take a `ReportLabels` object (already translated) — no i18n inside `src/`. Trilingual strings live only in `web/app/lib/i18n.ts` (LV/RU/EN; LV/RU typed `Record<keyof typeof EN, string>` so a missing key fails the build).
- **Domain imports use `.js` specifiers**. Web imports domain via `@domain/*`, web libs via `@/app/lib/*`.
- **Export route is read-only** — no role gate (matches the other `/api/reports/*` routes); auth via `getSessionToken` + `resolveTenantContext` + `withTenant`; dates validated with `isValidIsoDate` (`@/app/lib/date`); errors mapped with `errorToStatus` (`@/app/lib/authz`).
- **CSV**: RFC-4180 (quote a field iff it contains `,`/`"`/`\r`/`\n`; embedded `"`→`""`), rows joined `\r\n`, leading UTF-8 BOM (`﻿`).
- **Printable HTML** is a COMPLETE standalone document (`<!DOCTYPE html>…`) with a `.print-btn` that calls `window.print()` and `@media print { .print-btn { display:none } }` — the export route serves it directly as `text/html`.
- Tests: `npm test -- <path>` (targeted), ONE at a time (shared Postgres). Web build: `cd web && npm run -s build`. Root typecheck: `npm run -s typecheck`.

---

### Task 1: Tabular model + report serializers

**Files:**
- Create: `src/reports/tabular.ts`
- Test: `tests/reports/tabular.test.ts`

**Interfaces:**
- Consumes: report result types — `ProfitAndLoss`/`StatementSection`/`StatementLine` (`src/reports/profit-and-loss.js`), `BalanceSheet` (`src/reports/balance-sheet.js`), `ComparativeProfitAndLoss`/`ComparativeBalanceSheet`/`ComparativeSection`/`ComparativeLine` (`src/reports/comparative.js`), `GeneralLedger` (`src/reports/general-ledger.js`), `DatedBalanceRow` (`src/ledger/balances.js`), `ApAging` (`src/payables/aging.js`).
- Produces:
  - `type CellKind = 'data' | 'subtotal' | 'section' | 'opening' | 'closing'`
  - `interface ReportColumn { key: string; label: string; align: 'left' | 'right' }`
  - `interface ReportRow { cells: string[]; kind: CellKind }`
  - `interface ReportTable { title: string; meta: { label: string; value: string }[]; columns: ReportColumn[]; rows: ReportRow[] }`
  - `interface ReportLabels { … }` (the full field list below)
  - `profitAndLossTable(pl, labels, period)`, `comparativeProfitAndLossTable(c, labels)`, `balanceSheetTable(bs, labels)`, `comparativeBalanceSheetTable(c, labels)`, `generalLedgerTable(gl, labels)`, `trialBalanceTable(rows, labels, asOf)`, `apAgingTable(aging, labels)` — each `: ReportTable`.

- [ ] **Step 1: Write the failing test**

Create `tests/reports/tabular.test.ts`:

```ts
import { expect, test } from 'vitest';
import {
  profitAndLossTable, comparativeProfitAndLossTable, balanceSheetTable,
  generalLedgerTable, trialBalanceTable, apAgingTable, type ReportLabels,
} from '../../src/reports/tabular.js';

// Minimal English fixture labels (the web route supplies real translations).
const L: ReportLabels = {
  pl: 'Profit & Loss', bs: 'Balance Sheet', gl: 'General Ledger', trial: 'Trial Balance', apAging: 'Aged Payables',
  period: 'Period', asOf: 'As of', comparisonPeriod: 'Comparison', client: 'Client', generated: 'Generated',
  income: 'Income', expense: 'Expenses', assets: 'Assets', liabilities: 'Liabilities', equity: 'Equity',
  netProfit: 'Net profit', currentResult: 'Current-period result', totalAssets: 'Total assets', totalLiabEquity: 'Total liabilities & equity',
  code: 'Code', account: 'Account', amount: 'Amount', current: 'Current', comparison: 'Comparison', variance: 'Variance', variancePct: 'Variance %',
  date: 'Date', memo: 'Memo', description: 'Description', debit: 'Debit', credit: 'Credit', balance: 'Balance', opening: 'Opening', closing: 'Closing', total: 'Total',
  bucketCurrent: 'Current', d1_30: '1–30', d31_60: '31–60', d61_90: '61–90', d90plus: '90+',
};

test('profitAndLossTable lays out income + expense sections with subtotals and net', () => {
  const pl = {
    from: '2026-03-01', to: '2026-03-31',
    income: { lines: [{ code: '6110', name: 'Sales', amount: '300.00' }], subtotal: '300.00' },
    expense: { lines: [{ code: '7710', name: 'Expenses', amount: '120.00' }], subtotal: '120.00' },
    netProfit: '180.00',
  };
  const t = profitAndLossTable(pl, L, { from: '2026-03-01', to: '2026-03-31' });
  expect(t.title).toBe('Profit & Loss');
  expect(t.columns.map((c) => c.key)).toEqual(['code', 'account', 'amount']);
  // section header + line + subtotal for income, same for expense, then net
  const kinds = t.rows.map((r) => r.kind);
  expect(kinds).toContain('section');
  expect(kinds).toContain('subtotal');
  const net = t.rows.at(-1)!;
  expect(net.cells).toEqual(['', 'Net profit', '180.00']);
});

test('comparativeProfitAndLossTable adds comparison/variance/variance% columns', () => {
  const c = {
    current: { from: '2026-03-01', to: '2026-03-31' }, comparison: { from: '2026-02-01', to: '2026-02-28' },
    income: { lines: [{ code: '6110', name: 'Sales', current: '300.00', comparison: '100.00', variance: '200.00', variancePct: '200.0' }], current: '300.00', comparison: '100.00', variance: '200.00', variancePct: '200.0' },
    expense: { lines: [{ code: '7710', name: 'Expenses', current: '60.00', comparison: '0.00', variance: '60.00', variancePct: null }], current: '60.00', comparison: '0.00', variance: '60.00', variancePct: null },
    netProfit: { code: '', name: 'Net profit', current: '240.00', comparison: '100.00', variance: '140.00', variancePct: '140.0' },
  };
  const t = comparativeProfitAndLossTable(c, L);
  expect(t.columns.map((c) => c.key)).toEqual(['code', 'account', 'current', 'comparison', 'variance', 'variancePct']);
  const exp = t.rows.find((r) => r.cells[0] === '7710')!;
  expect(exp.cells).toEqual(['7710', 'Expenses', '60.00', '0.00', '60.00', '—']); // null pct → —
});

test('generalLedgerTable emits section/opening/data/closing rows per account', () => {
  const gl = {
    from: '2026-03-01', to: '2026-03-31',
    accounts: [{
      code: '2620', name: 'Bank', opening: '100.00', closing: '350.00', totalDebit: '300.00', totalCredit: '50.00',
      lines: [
        { entryId: 'e1', date: '2026-03-10', memo: 'Sale', description: 'in', debit: '300.00', credit: '0.00', balance: '400.00' },
        { entryId: 'e2', date: '2026-03-15', memo: 'Refund', description: null, debit: '0.00', credit: '50.00', balance: '350.00' },
      ],
    }],
  };
  const t = generalLedgerTable(gl, L);
  expect(t.columns.map((c) => c.key)).toEqual(['date', 'memo', 'description', 'debit', 'credit', 'balance']);
  expect(t.rows[0]!.kind).toBe('section');       // "2620 — Bank"
  expect(t.rows[1]!.kind).toBe('opening');
  expect(t.rows.at(-1)!.kind).toBe('closing');
});

test('trialBalanceTable and apAgingTable produce expected columns', () => {
  const tb = trialBalanceTable(
    [{ code: '2620', name: 'Bank', debit: '340.00', credit: '0.00', balance: '340.00', type: 'asset' }],
    L, '2026-03-31',
  );
  expect(tb.columns.map((c) => c.key)).toEqual(['code', 'account', 'debit', 'credit', 'balance']);
  const aging = apAgingTable(
    { asOf: '2026-06-15', current: '60.00', d1_30: '0.00', d31_60: '0.00', d61_90: '0.00', d90plus: '0.00', total: '60.00' }, L);
  expect(aging.columns.map((c) => c.key)).toEqual(['current', 'd1_30', 'd31_60', 'd61_90', 'd90plus', 'total']);
  expect(aging.rows[0]!.cells).toEqual(['60.00', '0.00', '0.00', '0.00', '0.00', '60.00']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/reports/tabular.test.ts`
Expected: FAIL — `src/reports/tabular.js` does not exist.

- [ ] **Step 3: Implement `src/reports/tabular.ts`**

```ts
import type { ProfitAndLoss, StatementSection } from './profit-and-loss.js';
import type { BalanceSheet } from './balance-sheet.js';
import type { ComparativeProfitAndLoss, ComparativeBalanceSheet, ComparativeSection, ComparativeLine } from './comparative.js';
import type { GeneralLedger } from './general-ledger.js';
import type { DatedBalanceRow } from './../ledger/balances.js';
import type { ApAging } from './../payables/aging.js';

export type CellKind = 'data' | 'subtotal' | 'section' | 'opening' | 'closing';
export interface ReportColumn { key: string; label: string; align: 'left' | 'right' }
export interface ReportRow { cells: string[]; kind: CellKind }
export interface ReportTable { title: string; meta: { label: string; value: string }[]; columns: ReportColumn[]; rows: ReportRow[] }

export interface ReportLabels {
  pl: string; bs: string; gl: string; trial: string; apAging: string;
  period: string; asOf: string; comparisonPeriod: string; client: string; generated: string;
  income: string; expense: string; assets: string; liabilities: string; equity: string;
  netProfit: string; currentResult: string; totalAssets: string; totalLiabEquity: string;
  code: string; account: string; amount: string; current: string; comparison: string; variance: string; variancePct: string;
  date: string; memo: string; description: string; debit: string; credit: string; balance: string; opening: string; closing: string; total: string;
  bucketCurrent: string; d1_30: string; d31_60: string; d61_90: string; d90plus: string;
}

const PCT = (v: string | null): string => (v === null ? '—' : v);
const nameFor = (code: string, name: string, labels: ReportLabels): string => (code === '' ? (name || labels.currentResult) : name);

// ---- single-period statements ----
function statementSection(title: string, s: StatementSection, labels: ReportLabels): ReportRow[] {
  const rows: ReportRow[] = [{ cells: [title, '', ''], kind: 'section' }];
  for (const l of s.lines) rows.push({ cells: [l.code, nameFor(l.code, l.name, labels), l.amount], kind: 'data' });
  rows.push({ cells: ['', title, s.subtotal], kind: 'subtotal' });
  return rows;
}

export function profitAndLossTable(pl: ProfitAndLoss, labels: ReportLabels, period: { from: string; to: string }): ReportTable {
  return {
    title: labels.pl,
    meta: [{ label: labels.period, value: `${period.from} – ${period.to}` }],
    columns: [
      { key: 'code', label: labels.code, align: 'left' },
      { key: 'account', label: labels.account, align: 'left' },
      { key: 'amount', label: labels.amount, align: 'right' },
    ],
    rows: [
      ...statementSection(labels.income, pl.income, labels),
      ...statementSection(labels.expense, pl.expense, labels),
      { cells: ['', labels.netProfit, pl.netProfit], kind: 'subtotal' },
    ],
  };
}

export function balanceSheetTable(bs: BalanceSheet, labels: ReportLabels): ReportTable {
  return {
    title: labels.bs,
    meta: [{ label: labels.asOf, value: bs.asOf }],
    columns: [
      { key: 'code', label: labels.code, align: 'left' },
      { key: 'account', label: labels.account, align: 'left' },
      { key: 'amount', label: labels.amount, align: 'right' },
    ],
    rows: [
      ...statementSection(labels.assets, bs.assets, labels),
      ...statementSection(labels.liabilities, bs.liabilities, labels),
      ...statementSection(labels.equity, bs.equity, labels),
      { cells: ['', labels.totalAssets, bs.totalAssets], kind: 'subtotal' },
      { cells: ['', labels.totalLiabEquity, bs.totalLiabilitiesAndEquity], kind: 'subtotal' },
    ],
  };
}

// ---- comparative statements ----
const cmpCols = (labels: ReportLabels): ReportColumn[] => [
  { key: 'code', label: labels.code, align: 'left' },
  { key: 'account', label: labels.account, align: 'left' },
  { key: 'current', label: labels.current, align: 'right' },
  { key: 'comparison', label: labels.comparison, align: 'right' },
  { key: 'variance', label: labels.variance, align: 'right' },
  { key: 'variancePct', label: labels.variancePct, align: 'right' },
];
function cmpLineRow(l: ComparativeLine, labels: ReportLabels, kind: CellKind = 'data'): ReportRow {
  return { cells: [l.code, nameFor(l.code, l.name, labels), l.current, l.comparison, l.variance, PCT(l.variancePct)], kind };
}
function cmpSection(title: string, s: ComparativeSection, labels: ReportLabels): ReportRow[] {
  const rows: ReportRow[] = [{ cells: [title, '', '', '', '', ''], kind: 'section' }];
  for (const l of s.lines) rows.push(cmpLineRow(l, labels));
  rows.push({ cells: ['', title, s.current, s.comparison, s.variance, PCT(s.variancePct)], kind: 'subtotal' });
  return rows;
}

export function comparativeProfitAndLossTable(c: ComparativeProfitAndLoss, labels: ReportLabels): ReportTable {
  return {
    title: labels.pl,
    meta: [
      { label: labels.period, value: `${c.current.from} – ${c.current.to}` },
      { label: labels.comparisonPeriod, value: `${c.comparison.from} – ${c.comparison.to}` },
    ],
    columns: cmpCols(labels),
    rows: [...cmpSection(labels.income, c.income, labels), ...cmpSection(labels.expense, c.expense, labels), cmpLineRow(c.netProfit, labels, 'subtotal')],
  };
}

export function comparativeBalanceSheetTable(c: ComparativeBalanceSheet, labels: ReportLabels): ReportTable {
  return {
    title: labels.bs,
    meta: [
      { label: labels.asOf, value: c.asOf },
      { label: labels.comparisonPeriod, value: c.comparisonAsOf },
    ],
    columns: cmpCols(labels),
    rows: [
      ...cmpSection(labels.assets, c.assets, labels),
      ...cmpSection(labels.liabilities, c.liabilities, labels),
      ...cmpSection(labels.equity, c.equity, labels),
      cmpLineRow(c.totalAssets, labels, 'subtotal'),
      cmpLineRow(c.totalLiabilitiesAndEquity, labels, 'subtotal'),
    ],
  };
}

// ---- general ledger ----
export function generalLedgerTable(gl: GeneralLedger, labels: ReportLabels): ReportTable {
  const rows: ReportRow[] = [];
  for (const a of gl.accounts) {
    rows.push({ cells: [`${a.code} — ${a.name}`, '', '', '', '', ''], kind: 'section' });
    rows.push({ cells: ['', labels.opening, '', '', '', a.opening], kind: 'opening' });
    for (const l of a.lines) rows.push({ cells: [l.date, l.memo, l.description ?? '', l.debit, l.credit, l.balance], kind: 'data' });
    rows.push({ cells: ['', labels.closing, '', a.totalDebit, a.totalCredit, a.closing], kind: 'closing' });
  }
  return {
    title: labels.gl,
    meta: [{ label: labels.period, value: `${gl.from} – ${gl.to}` }],
    columns: [
      { key: 'date', label: labels.date, align: 'left' },
      { key: 'memo', label: labels.memo, align: 'left' },
      { key: 'description', label: labels.description, align: 'left' },
      { key: 'debit', label: labels.debit, align: 'right' },
      { key: 'credit', label: labels.credit, align: 'right' },
      { key: 'balance', label: labels.balance, align: 'right' },
    ],
    rows,
  };
}

// ---- trial balance ----
export function trialBalanceTable(rows: DatedBalanceRow[], labels: ReportLabels, asOf: string): ReportTable {
  return {
    title: labels.trial,
    meta: [{ label: labels.asOf, value: asOf }],
    columns: [
      { key: 'code', label: labels.code, align: 'left' },
      { key: 'account', label: labels.account, align: 'left' },
      { key: 'debit', label: labels.debit, align: 'right' },
      { key: 'credit', label: labels.credit, align: 'right' },
      { key: 'balance', label: labels.balance, align: 'right' },
    ],
    rows: rows.map((r) => ({ cells: [r.code, r.name, r.debit, r.credit, r.balance], kind: 'data' as CellKind })),
  };
}

// ---- AP aging ----
export function apAgingTable(aging: ApAging, labels: ReportLabels): ReportTable {
  return {
    title: labels.apAging,
    meta: [{ label: labels.asOf, value: aging.asOf }],
    columns: [
      { key: 'current', label: labels.bucketCurrent, align: 'right' },
      { key: 'd1_30', label: labels.d1_30, align: 'right' },
      { key: 'd31_60', label: labels.d31_60, align: 'right' },
      { key: 'd61_90', label: labels.d61_90, align: 'right' },
      { key: 'd90plus', label: labels.d90plus, align: 'right' },
      { key: 'total', label: labels.total, align: 'right' },
    ],
    rows: [{ cells: [aging.current, aging.d1_30, aging.d31_60, aging.d61_90, aging.d90plus, aging.total], kind: 'data' }],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/reports/tabular.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/reports/tabular.ts tests/reports/tabular.test.ts
git commit -m "feat(export): format-neutral ReportTable model + report serializers (report-export)"
```

---

### Task 2: CSV encoder

**Files:**
- Create: `src/reports/csv.ts`
- Test: `tests/reports/csv.test.ts`

**Interfaces:**
- Consumes: `ReportTable` (Task 1).
- Produces: `tableToCsv(table: ReportTable): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/reports/csv.test.ts`:

```ts
import { expect, test } from 'vitest';
import { tableToCsv } from '../../src/reports/csv.js';
import type { ReportTable } from '../../src/reports/tabular.js';

const table: ReportTable = {
  title: 'Profit & Loss',
  meta: [{ label: 'Period', value: '2026-03-01 – 2026-03-31' }],
  columns: [
    { key: 'code', label: 'Code', align: 'left' },
    { key: 'account', label: 'Account', align: 'left' },
    { key: 'amount', label: 'Amount', align: 'right' },
  ],
  rows: [
    { cells: ['6110', 'Sales, net', '300.00'], kind: 'data' },      // comma → quoted
    { cells: ['7710', 'He said "hi"', '120.00'], kind: 'data' },    // quote → doubled
    { cells: ['', 'Line\nbreak', '0.00'], kind: 'data' },           // newline → quoted
  ],
};

test('tableToCsv is RFC-4180 with BOM and CRLF', () => {
  const csv = tableToCsv(table);
  expect(csv.charCodeAt(0)).toBe(0xfeff);                 // BOM
  expect(csv).toContain('\r\n');                          // CRLF line endings
  expect(csv).toContain('"Sales, net"');                 // comma field quoted
  expect(csv).toContain('"He said ""hi"""');             // embedded quotes doubled
  expect(csv).toContain('"Line\nbreak"');                // newline field quoted
  expect(csv).toContain('Code,Account,Amount');          // header row
  expect(csv).toContain('Profit & Loss');                // title line
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/reports/csv.test.ts`
Expected: FAIL — `src/reports/csv.js` does not exist.

- [ ] **Step 3: Implement `src/reports/csv.ts`**

```ts
import type { ReportTable } from './tabular.js';

const BOM = '﻿';

/** Quote a field iff it contains a comma, double-quote, CR, or LF; double embedded quotes. */
function field(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
const line = (cells: string[]): string => cells.map(field).join(',');

export function tableToCsv(table: ReportTable): string {
  const out: string[] = [];
  out.push(line([table.title]));
  for (const m of table.meta) out.push(line([m.label, m.value]));
  out.push('');
  out.push(line(table.columns.map((c) => c.label)));
  for (const r of table.rows) out.push(line(r.cells));
  return BOM + out.join('\r\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/reports/csv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reports/csv.ts tests/reports/csv.test.ts
git commit -m "feat(export): RFC-4180 CSV encoder for ReportTable (report-export)"
```

---

### Task 3: Printable HTML encoder

**Files:**
- Create: `src/reports/report-html.ts`
- Test: `tests/reports/report-html.test.ts`

**Interfaces:**
- Consumes: `ReportTable` (Task 1), `escapeXml` (`../xml/escape.js`).
- Produces: `reportDocumentHtml(table: ReportTable, opts: { printLabel: string }): string` — a COMPLETE standalone HTML document.

- [ ] **Step 1: Write the failing test**

Create `tests/reports/report-html.test.ts`:

```ts
import { expect, test } from 'vitest';
import { reportDocumentHtml } from '../../src/reports/report-html.js';
import type { ReportTable } from '../../src/reports/tabular.js';

const table: ReportTable = {
  title: 'Profit & Loss',
  meta: [{ label: 'Period', value: '2026-03-01 – 2026-03-31' }],
  columns: [
    { key: 'code', label: 'Code', align: 'left' },
    { key: 'account', label: 'Account', align: 'left' },
    { key: 'amount', label: 'Amount', align: 'right' },
  ],
  rows: [
    { cells: ['6110', 'Sales & <co>', '300.00'], kind: 'data' },
    { cells: ['', 'Net profit', '180.00'], kind: 'subtotal' },
  ],
};

test('reportDocumentHtml is a standalone doc with print button and escaped values', () => {
  const html = reportDocumentHtml(table, { printLabel: 'Print / Save as PDF' });
  expect(html).toMatch(/^<!DOCTYPE html>/);
  expect(html).toContain('<title>Profit &amp; Loss</title>');
  expect(html).toContain('window.print()');
  expect(html).toContain('Print / Save as PDF');
  expect(html).toContain('Sales &amp; &lt;co&gt;');       // HTML-escaped
  expect(html).toContain('2026-03-01 – 2026-03-31');       // meta rendered
  expect(html).toContain('class="subtotal"');              // subtotal row styled
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/reports/report-html.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `src/reports/report-html.ts`**

```ts
import type { ReportTable, ReportRow } from './tabular.js';
import { escapeXml } from '../xml/escape.js';

function bodyRow(r: ReportRow, aligns: ('left' | 'right')[]): string {
  const cls = r.kind === 'data' ? '' : ` class="${r.kind}"`;
  const tds = r.cells.map((c, i) => `<td class="${aligns[i] === 'right' ? 'num' : ''}">${escapeXml(c)}</td>`).join('');
  return `<tr${cls}>${tds}</tr>`;
}

export function reportDocumentHtml(table: ReportTable, opts: { printLabel: string }): string {
  const aligns = table.columns.map((c) => c.align);
  const head = table.columns.map((c) => `<th class="${c.align === 'right' ? 'num' : ''}">${escapeXml(c.label)}</th>`).join('');
  const meta = table.meta.map((m) => `<div><span class="meta-label">${escapeXml(m.label)}:</span> ${escapeXml(m.value)}</div>`).join('');
  const rows = table.rows.map((r) => bodyRow(r, aligns)).join('');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeXml(table.title)}</title>
<style>
  body { font-family: system-ui, sans-serif; color: #1a1a1a; max-width: 900px; margin: 0 auto; padding: 32px; }
  h1 { font-size: 1.5rem; margin: 0 0 8px; }
  .meta { color: #555; font-size: 0.9rem; margin-bottom: 16px; }
  .meta-label { color: #888; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 6px 8px; border-bottom: 1px solid #ddd; text-align: left; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  tr.section td { font-weight: 700; background: #f5f5f5; }
  tr.subtotal td { font-weight: 600; border-top: 2px solid #bbb; }
  tr.opening td, tr.closing td { font-style: italic; color: #444; }
  .print-btn { margin-bottom: 16px; padding: 8px 16px; font-size: 0.9rem; cursor: pointer; }
  @media print { .print-btn { display: none !important; } body { padding: 0; } }
</style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">${escapeXml(opts.printLabel)}</button>
  <h1>${escapeXml(table.title)}</h1>
  <div class="meta">${meta}</div>
  <table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>
</body>
</html>`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/reports/report-html.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/reports/report-html.ts tests/reports/report-html.test.ts
git commit -m "feat(export): printable standalone HTML encoder for ReportTable (report-export)"
```

---

### Task 4: xlsx encoder (ExcelJS)

**Files:**
- Modify: `web/package.json` (add `exceljs`)
- Create: `web/app/lib/report-xlsx.ts`

**Interfaces:**
- Consumes: `ReportTable` (Task 1), `exceljs`.
- Produces: `tableToXlsx(table: ReportTable): Promise<Buffer>`.

**Verification note:** ExcelJS is a **web-only** dependency (installed in `web/node_modules`),
and the root vitest cannot resolve it (or `@domain/*`) from `tests/`, and the repo has no
web-side test runner. So this encoder is **verified by the web build (`tsc`/Next typecheck of
the actual ExcelJS API usage)**, exactly as the M7/M14 web-layer modules were — not by a root
unit test. Its runtime output is exercised end-to-end by the export route (Task 5): hitting
`?format=xlsx` returns a real workbook buffer. Do NOT add a `tests/reports/report-xlsx.test.ts`
under root vitest — it would fail to resolve `exceljs`.

- [ ] **Step 1: Add the ExcelJS dependency**

Run: `cd web && npm install exceljs@^4`
Expected: `exceljs` appears under `dependencies` in `web/package.json`; `web/package-lock.json` updates. (This is the one new dependency, web-only.)

- [ ] **Step 2: Implement `web/app/lib/report-xlsx.ts`**

```ts
import ExcelJS from 'exceljs';
import type { ReportTable } from '@domain/reports/tabular.js';

/** Render a ReportTable to an .xlsx workbook buffer (one worksheet). */
export async function tableToXlsx(table: ReportTable): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  // Worksheet names are limited to 31 chars and cannot contain []:*?/\ — sanitize.
  const safeName = table.title.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Report';
  const ws = wb.addWorksheet(safeName);

  ws.addRow([table.title]);
  for (const m of table.meta) ws.addRow([m.label, m.value]);
  ws.addRow([]);
  const header = ws.addRow(table.columns.map((c) => c.label));
  header.font = { bold: true };
  for (const r of table.rows) ws.addRow(r.cells);

  // Right-align numeric columns.
  table.columns.forEach((c, i) => { if (c.align === 'right') ws.getColumn(i + 1).alignment = { horizontal: 'right' }; });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
```

- [ ] **Step 3: Verify it compiles against the ExcelJS API (web build)**

Run: `cd web && npm run -s build`
Expected: exit 0, no type errors (ignore only the pre-existing "multiple lockfiles" warning). A wrong ExcelJS method/shape fails the typecheck here. (Full compilation including the route happens in Task 5; running the build now catches ExcelJS API mistakes early against just this module.)

- [ ] **Step 4: Commit**

```bash
git add web/package.json web/package-lock.json web/app/lib/report-xlsx.ts
git commit -m "feat(export): xlsx encoder via ExcelJS (report-export)"
```

---

### Task 5: Export API route

**Files:**
- Create: `web/app/api/reports/export/route.ts`

**Interfaces:**
- Consumes: the report domain functions (`profitAndLoss`, `comparativeProfitAndLoss`, `balanceSheet`, `comparativeBalanceSheet`, `generalLedger`, `accountBalances`, `apAging`), the serializers (Task 1), `tableToCsv` (Task 2), `reportDocumentHtml` (Task 3), `tableToXlsx` (Task 4), a `ReportLabels` built from request `lang`.
- Produces: `GET /api/reports/export` returning the encoded file / HTML.

- [ ] **Step 1: Read the existing report + download routes**

Run: `sed -n '1,45p' web/app/api/reports/general-ledger/route.ts && sed -n '1,30p' web/app/api/pay-runs/[id]/route.ts`
Mirror their auth/validation/error patterns and the `content-disposition` download shape.

- [ ] **Step 2: Create `web/app/api/reports/export/route.ts`**

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { profitAndLoss } from '@domain/reports/profit-and-loss.js';
import { balanceSheet } from '@domain/reports/balance-sheet.js';
import { comparativeProfitAndLoss, comparativeBalanceSheet } from '@domain/reports/comparative.js';
import { generalLedger } from '@domain/reports/general-ledger.js';
import { accountBalances } from '@domain/ledger/balances.js';
import { apAging } from '@domain/payables/aging.js';
import {
  profitAndLossTable, comparativeProfitAndLossTable, balanceSheetTable, comparativeBalanceSheetTable,
  generalLedgerTable, trialBalanceTable, apAgingTable, type ReportTable,
} from '@domain/reports/tabular.js';
import { tableToCsv } from '@domain/reports/csv.js';
import { reportDocumentHtml } from '@domain/reports/report-html.js';
import { tableToXlsx } from '@/app/lib/report-xlsx';
import { reportLabels, type ExportLang } from '@/app/lib/report-labels';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { isValidIsoDate } from '@/app/lib/date';
import { errorToStatus } from '@/app/lib/authz';

const REPORTS = ['pl', 'bs', 'gl', 'trial', 'apaging'] as const;
const FORMATS = ['csv', 'xlsx', 'pdf'] as const;
type ReportKind = (typeof REPORTS)[number];
type Format = (typeof FORMATS)[number];

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function firstOfMonthIso(): string { return todayIso().slice(0, 8) + '01'; }

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const clientCompanyId = q.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  const report = q.get('report') as ReportKind | null;
  const format = q.get('format') as Format | null;
  if (!report || !REPORTS.includes(report)) return NextResponse.json({ error: 'invalid report' }, { status: 400 });
  if (!format || !FORMATS.includes(format)) return NextResponse.json({ error: 'invalid format' }, { status: 400 });

  const lang = (q.get('lang') ?? 'lv') as ExportLang;
  const from = q.get('from') ?? firstOfMonthIso();
  const to = q.get('to') ?? todayIso();
  const asOf = q.get('asOf') ?? todayIso();
  const compareFrom = q.get('compareFrom');
  const compareTo = q.get('compareTo');
  const compareAsOf = q.get('compareAsOf');
  const account = q.get('account');
  for (const d of [from, to, asOf, compareFrom, compareTo, compareAsOf]) {
    if (d !== null && !isValidIsoDate(d)) return NextResponse.json({ error: 'dates must be YYYY-MM-DD' }, { status: 400 });
  }

  const L = reportLabels(lang);

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const table: ReportTable = await withTenant(ctx, async (tx) => {
      switch (report) {
        case 'pl':
          if (compareFrom && compareTo) {
            const c = await comparativeProfitAndLoss(tx, ctx, { current: { from, to }, comparison: { from: compareFrom, to: compareTo } });
            return comparativeProfitAndLossTable(c, L);
          }
          return profitAndLossTable(await profitAndLoss(tx, ctx, { from, to }), L, { from, to });
        case 'bs':
          if (compareAsOf) {
            const c = await comparativeBalanceSheet(tx, ctx, { asOf, comparisonAsOf: compareAsOf });
            return comparativeBalanceSheetTable(c, L);
          }
          return balanceSheetTable(await balanceSheet(tx, ctx, { asOf }), L);
        case 'gl':
          return generalLedgerTable(await generalLedger(tx, ctx, { from, to, ...(account ? { accountCodes: [account] } : {}) }), L);
        case 'trial':
          return trialBalanceTable(await accountBalances(tx, ctx, {}), L, asOf);
        case 'apaging':
          return apAgingTable(await apAging(tx, ctx, { asOf }), L);
      }
    });

    const stamp = report === 'bs' || report === 'apaging' || report === 'trial' ? asOf : `${from}_${to}`;
    if (format === 'pdf') {
      const html = reportDocumentHtml(table, { printLabel: L.print });
      return new NextResponse(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (format === 'csv') {
      return new NextResponse(tableToCsv(table), {
        status: 200,
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${report}-${stamp}.csv"` },
      });
    }
    const buf = await tableToXlsx(table);
    return new NextResponse(buf, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${report}-${stamp}.xlsx"`,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}
```

- [ ] **Step 3: Create `web/app/lib/report-labels.ts`** (builds `ReportLabels` from the web i18n so the route stays declarative)

```ts
import type { ReportLabels } from '@domain/reports/tabular.js';
import { EN, LV, RU } from '@/app/lib/i18n';

export type ExportLang = 'lv' | 'en' | 'ru';
const PACKS: Record<ExportLang, typeof EN> = { en: EN, lv: LV, ru: RU };

/** Map the report-export i18n keys into the domain ReportLabels shape, plus the print button label. */
export function reportLabels(lang: ExportLang): ReportLabels & { print: string } {
  const m = PACKS[lang] ?? PACKS.lv;
  return {
    pl: m['reports.tab.pl'], bs: m['reports.tab.bs'], gl: m['reports.tab.gl'], trial: m['reports.tab.trial'], apAging: m['reports.tab.apaging'],
    period: m['reports.from'], asOf: m['reports.asOf'], comparisonPeriod: m['reports.compareTo'], client: m['export.client'], generated: m['export.generated'],
    income: m['reports.income'], expense: m['reports.expense'], assets: m['reports.assets'], liabilities: m['reports.liabilities'], equity: m['reports.equity'],
    netProfit: m['reports.netProfit'], currentResult: m['reports.currentResult'], totalAssets: m['reports.totalAssets'], totalLiabEquity: m['reports.totalLiabEquity'],
    code: m['reports.col.code'], account: m['reports.col.account'], amount: m['reports.col.amount'],
    current: m['reports.col.current'], comparison: m['reports.col.comparison'], variance: m['reports.col.variance'], variancePct: m['reports.col.variancePct'],
    date: m['reports.col.date'], memo: m['reports.col.memo'], description: m['reports.col.description'], debit: m['reports.col.debit'], credit: m['reports.col.credit'],
    balance: m['reports.col.balance'], opening: m['reports.gl.opening'], closing: m['reports.gl.closing'], total: m['reports.col.total'],
    bucketCurrent: m['reports.aging.current'], d1_30: m['reports.aging.d1_30'], d31_60: m['reports.aging.d31_60'], d61_90: m['reports.aging.d61_90'], d90plus: m['reports.aging.d90plus'],
    print: m['export.print'],
  };
}
```

Note: reference the ACTUAL i18n key names present after M14. If any key above does not exist (e.g. `reports.netProfit`, `reports.totalAssets`, `reports.col.account`, `reports.col.amount`, `reports.col.total`, the `reports.aging.*` bucket labels, `reports.asOf`), add it in Task 6 Step 2 across EN/LV/RU. `EN`/`LV`/`RU` must be exported from `web/app/lib/i18n.ts` — if they are not already exported, export them in Task 6 (they are the existing per-language maps).

- [ ] **Step 4: Typecheck + build**

Run: `npm run -s typecheck && cd web && npm run -s build`
Expected: clean (ignore only the pre-existing "multiple lockfiles" warning). If a referenced i18n key or the `EN`/`LV`/`RU` exports are missing, this fails — fix by doing Task 6 Step 2 first (add keys / export the maps), then re-run. It is fine to interleave: create the keys now if the build demands them.

- [ ] **Step 5: Commit**

```bash
git add web/app/api/reports/export/route.ts web/app/lib/report-labels.ts
git commit -m "feat(export): unified /api/reports/export route (csv/xlsx/pdf) (report-export)"
```

---

### Task 6: Reports page export buttons + i18n

**Files:**
- Modify: `web/app/(cabinet)/reports/page.tsx`
- Modify: `web/app/(cabinet)/reports/page.module.css` (small export-button styling; reuse existing classes where possible)
- Modify: `web/app/lib/i18n.ts` (export `EN`/`LV`/`RU` if not already; add any missing keys referenced by `report-labels.ts`, all three languages)

**Interfaces:**
- Consumes: `GET /api/reports/export` (Task 5).

- [ ] **Step 1: Confirm the i18n export + key inventory**

Run: `grep -n "export const EN\|export const LV\|export const RU\|const EN\|const LV\|const RU" web/app/lib/i18n.ts && grep -n "reports.col.account\|reports.col.amount\|reports.col.total\|reports.netProfit\|reports.totalAssets\|reports.totalLiabEquity\|reports.asOf\|reports.aging.current\|export.print\|export.csv\|export.excel\|export.pdf" web/app/lib/i18n.ts`
Note which of the referenced keys already exist and whether `EN`/`LV`/`RU` are exported.

- [ ] **Step 2: Export the language maps + add missing keys**

In `web/app/lib/i18n.ts`: ensure `EN`, `LV`, `RU` are `export const` (change `const` → `export const` if needed — do not rename). Add any keys referenced by `report-labels.ts` that are missing, in ALL THREE blocks, following the existing `reports.*` style. New keys likely needed: `reports.col.account`, `reports.col.amount`, `reports.col.total`, `reports.netProfit`, `reports.totalAssets`, `reports.totalLiabEquity`, `reports.asOf`, `reports.aging.current`, `reports.aging.d1_30`, `reports.aging.d31_60`, `reports.aging.d61_90`, `reports.aging.d90plus`, plus the export UI/button labels: `export.print` (e.g. "Print / Save as PDF" / "Drukāt / Saglabāt PDF" / "Печать / Сохранить PDF"), `export.csv` ("CSV"), `export.excel` ("Excel"), `export.pdf` ("PDF"), `export.client`, `export.generated`. Reuse existing keys where they already carry the right text (e.g. `reports.currentResult`, `reports.income`, `reports.expense`, `reports.assets`, `reports.liabilities`, `reports.equity`, `reports.gl.opening`, `reports.gl.closing`, `reports.col.date/memo/description/debit/credit/balance/current/comparison/variance/variancePct`, `reports.from`, `reports.compareTo`, `reports.tab.*`).

- [ ] **Step 3: Add an `exportUrl` helper + export controls in the page**

In `web/app/(cabinet)/reports/page.tsx`, add a helper that builds the export URL from the active tab's state and the current locale, and render three controls (CSV, Excel download anchors; PDF opens in a new tab) in each tab's control bar:

```tsx
// `lang` is the active locale from useMessages(); map the app's tab id to the export `report` id.
const exportReport = (): 'pl' | 'bs' | 'gl' | 'trial' | 'apaging' => tab; // Tab ids already match
const exportUrl = (format: 'csv' | 'xlsx' | 'pdf'): string => {
  const p = new URLSearchParams({ clientCompanyId: clientCompanyId!, report: exportReport(), format, lang });
  if (tab === 'pl' || tab === 'gl') { p.set('from', from); p.set('to', to); }
  if (tab === 'bs' || tab === 'trial' || tab === 'apaging') p.set('asOf', asOf);
  if (tab === 'pl' && compareFrom && compareTo) { p.set('compareFrom', compareFrom); p.set('compareTo', compareTo); }
  if (tab === 'bs' && compareAsOf) p.set('compareAsOf', compareAsOf);
  if (tab === 'gl' && glAccount) p.set('account', glAccount);
  return `/api/reports/export?${p.toString()}`;
};

// In each tab's controls (only when the report has loaded / clientCompanyId present):
<div className={styles.exportBar}>
  <a className={styles.exportLink} href={exportUrl('csv')} download>{t('export.csv')}</a>
  <a className={styles.exportLink} href={exportUrl('xlsx')} download>{t('export.excel')}</a>
  <a className={styles.exportLink} href={exportUrl('pdf')} target="_blank" rel="noopener noreferrer">{t('export.pdf')}</a>
</div>
```

Guard `clientCompanyId!` behind the existing "no client selected" handling so the bar only renders when a client is set. Add a `.exportBar` / `.exportLink` rule to `page.module.css` (small inline-flex row, gap, link styling consistent with existing buttons).

- [ ] **Step 4: Typecheck + build (foreground, wait — no background job)**

Run: `cd web && npm run -s build`
Expected: exit 0, no type errors (ignore only the pre-existing "multiple lockfiles" warning).

- [ ] **Step 5: Commit**

```bash
git add "web/app/(cabinet)/reports/page.tsx" "web/app/(cabinet)/reports/page.module.css" web/app/lib/i18n.ts
git commit -m "feat(export): per-report CSV/Excel/PDF export buttons on /reports (report-export)"
```

---

### Task 7: Docs — roadmap + handoff

**Files:**
- Modify: `docs/ROADMAP-market-gaps.md` (M14 row → export shipped)
- Modify: `HANDOFF.md`

- [ ] **Step 1: Update the M14 roadmap row**

In `docs/ROADMAP-market-gaps.md`, update the M14 row: change 🔶 to ✅ and note that report export (CSV via `src/reports/csv.ts`, Excel via ExcelJS in `web/app/lib/report-xlsx.ts`, printable PDF via `src/reports/report-html.ts`, over the neutral `src/reports/tabular.ts` model) now ships for all five reports through `GET /api/reports/export`, completing M14. Reference `docs/superpowers/specs/2026-07-18-report-export-design.md`.

- [ ] **Step 2: Update HANDOFF**

In `HANDOFF.md`, add a bullet under the market-gaps block: report export shipped 2026-07-18 (CSV/xlsx/printable-PDF for P&L, Balance Sheet, General Ledger, Trial Balance, AP aging); M14 now complete.

- [ ] **Step 3: Commit**

```bash
git add docs/ROADMAP-market-gaps.md HANDOFF.md
git commit -m "docs: report export shipped — M14 complete (report-export)"
```

---

## Self-Review

**1. Spec coverage:**
- Neutral tabular model + per-report serializers (all 5 reports + comparative variants) → Task 1. ✅
- CSV encoder (RFC-4180, BOM) → Task 2. ✅
- Printable HTML (standalone, print button, mirrors invoice-html) → Task 3. ✅
- xlsx via ExcelJS (web-only dep) → Task 4. ✅
- One export route dispatching report+format, correct content-types + content-disposition, pdf=html-no-attachment → Task 5. ✅
- UI export buttons carrying current tab state + locale → Task 6. ✅
- i18n LV/RU/EN, domain stays label-agnostic → Tasks 1 (labels param) + 6 (keys). ✅
- No migration; money stays decimal strings → honored. ✅
- Out-of-scope (scheduled/emailed, multi-report workbook, non-report data, server PDF libs) → not built. ✅

**2. Placeholder scan:** Tasks 1–5 carry complete code. Task 6 is described at the concrete-change level (exact `exportUrl`, controls, key inventory) — consistent with the M7/M14 UI tasks, verified by the web build. The `report-labels.ts` key mapping names real keys and Task 6 Step 1–2 reconcile any missing ones against the actual file before the build gate — no "TBD".

**3. Type consistency:** `ReportTable`/`ReportRow`/`ReportColumn`/`ReportLabels` (Task 1) are consumed by `tableToCsv` (2), `reportDocumentHtml` (3), `tableToXlsx` (4), the serializers, and the route (5). `reportLabels()` returns `ReportLabels & { print }` consumed by the route. Domain report result types match their existing definitions (verified against `src/reports/*` and `src/ledger/balances.ts`, `src/payables/aging.ts`). The route's report/format allow-lists match the UI's `exportUrl`. ExcelJS import is web-only.

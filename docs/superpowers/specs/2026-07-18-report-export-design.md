# Report Export (M14 follow-on) — Design

Date: 2026-07-18. Design for **report export** — the deferred slice of M14
(`docs/ROADMAP-market-gaps.md`). M14 shipped the report *data* (P&L, Balance Sheet,
General Ledger, Trial Balance, AP aging over `src/reports/` + `src/ledger/`); this adds
CSV, Excel (`.xlsx`), and printable-PDF export of every one of those reports.

**Goal:** from each report tab on `/reports`, download the report as CSV or Excel, or open a
print-optimized HTML view to save as PDF — exporting exactly what is on screen (period,
comparison, GL account), in the user's language.

---

## Decisions (agreed during brainstorming)

1. **Three formats:** CSV (zero new dep), Excel `.xlsx` (new **ExcelJS** dependency), and
   **printable-HTML PDF** (browser Print/Save-as-PDF — the pattern invoices already use via
   `src/einvoice/invoice-html.ts`; no server-side PDF library).
2. **All five reports:** P&L, Balance Sheet, General Ledger, Trial Balance, AP aging.
   Comparative P&L/BS export includes the `comparison / variance / variance %` columns when
   compare mode is on; otherwise the single-period columns.
3. **Neutral tabular model + shared encoders** (Approach A) — each report serialized once into
   a format-neutral table; CSV/xlsx/HTML encoders consume that table.

---

## Context — what already exists (reused, not rebuilt)

- **Report domain** (`src/reports/`, `src/ledger/`): `profitAndLoss`, `balanceSheet`,
  `generalLedger`, `comparativeProfitAndLoss`, `comparativeBalanceSheet`, `apAging`,
  `accountBalances` (trial balance). All return structured objects with decimal-string money.
- **Printable-HTML precedent**: `src/einvoice/invoice-html.ts` renders a self-contained,
  trilingual, escaped HTML document with a "Print / Save as PDF" button and `@media print`
  styling; served to the browser and printed. Report PDF mirrors this exactly.
- **File-download precedent**: `web/app/api/pay-runs/[id]/route.ts` returns a file via
  `new NextResponse(body, { headers: { 'content-type', 'content-disposition': 'attachment; filename=...' } })`.
- **Shared web helpers**: `isValidIsoDate` (`@/app/lib/date`), `errorToStatus` (`@/app/lib/authz`),
  `getSessionToken`/`nowUnix` (`@/app/lib/session`), `resolveTenantContext` + `withTenant`.
- **Money**: integer cents (`toCents`/`fromCents`); reports already present decimal strings.
- **i18n**: `web/app/lib/i18n.ts`, LV/RU typed `Record<keyof typeof EN, string>`.

**No migration** — read-only over the existing reports.

---

## Section 1 — Tabular model + serializers (`src/reports/tabular.ts`)

A format-neutral representation every encoder consumes:

```ts
export type CellAlign = 'left' | 'right';
export interface ReportColumn { key: string; label: string; align: CellAlign }
export interface ReportTable {
  title: string;                       // e.g. "Profit & Loss"
  meta: { label: string; value: string }[];  // e.g. Period / As of / Client
  columns: ReportColumn[];
  rows: { cells: string[]; kind?: 'data' | 'subtotal' | 'section' | 'opening' | 'closing' }[];
}
```

One serializer per report maps its structured result into a `ReportTable`, given a
`DocLang` ('lv' | 'en' | 'ru') for labels:

- `profitAndLossTable(pl, lang)` / `balanceSheetTable(bs, lang)` — code / name / amount rows
  per section with a `subtotal` row; the `''`-coded current-period-result line renders with
  its localized name.
- `comparativeProfitAndLossTable(c, lang)` / `comparativeBalanceSheetTable(c, lang)` — adds
  `comparison`, `variance`, `variance %` columns (variancePct `null` → `—`).
- `generalLedgerTable(gl, lang)` — a single table across accounts: a `section` row per
  account (`code — name`), an `opening` row, `data` rows (date / memo / description / debit /
  credit / running balance), and a `closing` row with column totals.
- `trialBalanceTable(rows, lang)` — code / name / debit / credit / balance.
- `apAgingTable(aging, lang)` — columns are the six buckets (current / 1–30 / 31–60 / 61–90 /
  90+ / total) with a single `data` row of their amounts, plus the as-of date in `meta`.

Labels live in a `LABELS: Record<DocLang, …>` map in this module, mirroring
`invoice-html.ts`. Pure functions, no I/O — fully unit-testable over fixture report objects.

---

## Section 2 — Encoders

- **CSV** — `src/reports/csv.ts`, `tableToCsv(table): string`. RFC-4180: fields containing
  `,` `"` or newline are wrapped in double quotes with embedded quotes doubled; rows joined
  with `\r\n`. Emits the `title` + `meta` as leading lines, a blank line, the column header
  row, then data rows. Prefixed with a UTF-8 BOM (`﻿`) so Excel opens LV/RU text
  correctly. Pure, zero-dependency, tested.
- **xlsx** — `web/app/lib/report-xlsx.ts`, `tableToXlsx(table): Promise<Buffer>` using
  **ExcelJS** (added to `web/package.json`). One worksheet named after the report; a title
  row, meta rows, a bold header row, then data rows; `right`-aligned columns per
  `column.align`; `workbook.xlsx.writeBuffer()`. Lives in the web layer because ExcelJS runs
  in the Node route (keeps `src/` dependency-free).
- **Printable HTML** — `src/reports/report-html.ts`, `reportDocumentHtml(table, lang): string`.
  A self-contained HTML document (inline `<style>`, `@media print` hiding the toolbar, a
  "Print / Save as PDF" button calling `window.print()`), title + meta header, and the table
  — **mirroring `src/einvoice/invoice-html.ts`** (same escaping via `escapeXml`, trilingual
  labels, print CSS). Pure, tested.

---

## Section 3 — Delivery (route + UI)

**One export route** — `web/app/api/reports/export/route.ts`:
`GET /api/reports/export?clientCompanyId=&report=<pl|bs|gl|trial|apaging>&format=<csv|xlsx|pdf>&<report params>`.

- Auth + `resolveTenantContext` + `withTenant` as the other report routes.
- Validates `report` and `format` against fixed allow-lists (unknown → 400) and dates via
  `isValidIsoDate`; errors mapped with `errorToStatus`.
- Calls the matching existing domain report function with the same params the tab uses —
  `from`/`to` (P&L, GL), `asOf` (BS, aging), optional `compareFrom`/`compareTo` (P&L),
  `compareAsOf` (BS), `account` (GL) — choosing the comparative serializer when compare
  params are present. Builds the `ReportTable`, then encodes per `format`:
  - `csv` → `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<report>-<stamp>.csv"`.
  - `xlsx` → the ExcelJS buffer, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, attachment filename.
  - `pdf` → `text/html; charset=utf-8`, **no** attachment header — opens in a new tab; the
    user prints/saves as PDF (exactly like invoices).
- `lang` comes from a request param (the UI passes the active locale); defaults to `lv`.
- Read-only; no role gate (matches the existing `/api/reports/*` routes).

**UI** — on `web/app/(cabinet)/reports/page.tsx`, each report tab gets a small export control:
**CSV** and **Excel** as download anchors (`<a href={exportUrl(report,'csv'|'xlsx')} download>`)
and **PDF** as an anchor opening `exportUrl(report,'pdf')` with `target="_blank"`. `exportUrl`
builds the query string from the tab's current state (period, compare inputs, GL account,
locale), so the export always matches what is displayed. New visible strings are `t()` keys
in `web/app/lib/i18n.ts` for LV/RU/EN.

---

## Section 4 — Testing

Follows the house convention (no migration; domain + tests + API route + UI; ExcelJS added
to `web/package.json`):

- **`tabular.ts`** — each serializer maps a fixture report to the expected columns/rows;
  comparative variants include the variance columns and render `variancePct: null` as `—`;
  GL includes `opening`/`closing`/`section` rows.
- **`csv.ts`** — RFC-4180 escaping (a field with a comma, a field with an embedded quote, a
  field with a newline), `\r\n` line endings, leading BOM, header + data ordering.
- **`report-html.ts`** — output contains the title, the print button, all row values
  HTML-escaped, and the correct trilingual labels.
- **`report-xlsx.ts`** — `tableToXlsx` returns a non-empty buffer; reading it back with
  ExcelJS yields the expected worksheet name and header row (light round-trip).
- **Export route** — happy path per format asserts the `content-type` and (csv/xlsx)
  `content-disposition: attachment`; `pdf` returns `text/html` with **no** attachment header;
  unknown `report`/`format` and bad dates → 400. Web build confirms compilation.

---

## Out of scope (separate asks)

- Scheduled / emailed exports.
- A combined multi-report workbook (one sheet per report in a single `.xlsx`).
- Export of non-report data (journal browser, bills/invoice lists).
- Server-side PDF rendering libraries (the printable-HTML→browser-print path is deliberate,
  matching invoices).

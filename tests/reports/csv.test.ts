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

const injectionTable: ReportTable = {
  title: 'Injection check',
  meta: [],
  columns: [
    { key: 'code', label: 'Code', align: 'left' },
    { key: 'desc', label: 'Description', align: 'left' },
    { key: 'amount', label: 'Amount', align: 'right' },
  ],
  rows: [
    { cells: ['1', '=SUM(A1:A9)', '0.00'], kind: 'data' },       // formula trigger, no comma
    { cells: ['2', '=SUM(A1,A9)', '0.00'], kind: 'data' },       // formula trigger + comma → neutralized AND quoted
    { cells: ['3', '@cmd', '0.00'], kind: 'data' },              // @ trigger
    { cells: ['4', '+cmd', '0.00'], kind: 'data' },              // + trigger, non-numeric
    { cells: ['5', '-- note', '0.00'], kind: 'data' },           // leading dash, non-numeric text
    { cells: ['6', 'Refund', '-50.00'], kind: 'data' },          // legitimate negative money, must NOT be altered
  ],
};

test('tableToCsv neutralizes CSV formula injection on non-numeric cells', () => {
  const csv = tableToCsv(injectionTable);
  expect(csv).toContain("'=SUM(A1:A9)");                  // bare formula → single-quote prefixed
  expect(csv).toContain('"\'=SUM(A1,A9)"');               // neutralized AND comma-quoted
  expect(csv).toContain("'@cmd");                         // @ trigger neutralized
  expect(csv).toContain("'+cmd");                         // + trigger neutralized ('+1' would be numeric and skipped)
  expect(csv).toContain("'-- note");                      // leading-dash text neutralized
  expect(csv).toContain(',-50.00');                       // legitimate money value left intact, no leading quote
  expect(csv).not.toContain("'-50.00");
});

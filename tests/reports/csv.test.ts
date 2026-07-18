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

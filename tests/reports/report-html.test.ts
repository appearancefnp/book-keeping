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

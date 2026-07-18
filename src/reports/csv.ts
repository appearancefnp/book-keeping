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

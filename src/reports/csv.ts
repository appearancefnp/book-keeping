import type { ReportTable } from './tabular.js';

const BOM = '﻿';

/**
 * OWASP CSV-injection: a text cell starting with a formula trigger ( = + - @ tab CR )
 * is prefixed with a single quote so spreadsheet apps treat it as inert text.
 * Numeric money strings (e.g. -50.00) are left intact so Excel can still sum them.
 */
function neutralize(v: string): string {
  if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) return `'${v}`;
  return v;
}

/** Quote a field iff it contains a comma, double-quote, CR, or LF; double embedded quotes. */
function field(v: string): string {
  const nv = neutralize(v);
  return /[",\r\n]/.test(nv) ? `"${nv.replace(/"/g, '""')}"` : nv;
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

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

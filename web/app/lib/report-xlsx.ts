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

import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { InvoiceLineIn } from './ubl.js';
import type { VatCategory } from '../tax/categories.js';
import { toCents } from '../db/money.js';

export interface EinvoiceLineRow {
  lineNo: number; description: string;
  netCents: string; vatRate: string; vatCents: string; vatCategory: VatCategory;
}

/**
 * Persist the line detail of an OUTBOUND einvoice. Inbound documents already land as
 * bill_lines via receiveInboundInvoices — writing both would double-count the purchase
 * side of the VAT breakdown, so this is only ever called on the outbound path.
 */
export async function insertEinvoiceLines(
  tx: PoolClient, ctx: TenantContext, einvoiceId: string, lines: InvoiceLineIn[],
): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    await tx.query(
      `INSERT INTO einvoice_lines(client_company_id, einvoice_id, line_no, description, net_cents, vat_rate, vat_cents, vat_category)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ctx.clientCompanyId, einvoiceId, i + 1, l.description,
        toCents(l.net).toString(), l.vatRate, toCents(l.vat).toString(), l.vatCategory ?? 'S'],
    );
  }
}

export async function listEinvoiceLines(
  tx: PoolClient, ctx: TenantContext, einvoiceId: string,
): Promise<EinvoiceLineRow[]> {
  const res = await tx.query(
    `SELECT line_no AS "lineNo", description, net_cents::text AS "netCents",
            vat_rate::text AS "vatRate", vat_cents::text AS "vatCents", vat_category AS "vatCategory"
     FROM einvoice_lines WHERE einvoice_id = $1 AND client_company_id = $2 ORDER BY line_no`,
    [einvoiceId, ctx.clientCompanyId],
  );
  return res.rows;
}

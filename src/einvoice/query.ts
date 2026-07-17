import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface EinvoiceRow {
  id: string;
  direction: 'outbound' | 'inbound';
  invoiceNumber: string;
  issueDate: string;
  grandTotalCents: string;
  currency: string;
  peppolStatus: string;
  peppolMessageId: string | null;
  vidStatus: string;
  vidDueDate: string | null;
  journalEntryId: string | null;
  createdAt: string;
  docType: 'invoice' | 'credit_note';
  correctedInvoiceNumber: string | null;
}

export async function listEinvoices(
  tx: PoolClient,
  ctx: TenantContext,
  filter: { direction?: 'outbound' | 'inbound'; limit?: number } = {},
): Promise<EinvoiceRow[]> {
  const params: unknown[] = [ctx.clientCompanyId];
  let where = 'client_company_id = $1';
  if (filter.direction) {
    params.push(filter.direction);
    where += ` AND direction = $${params.length}`;
  }
  params.push(filter.limit ?? 50);
  const res = await tx.query(
    `SELECT id, direction, invoice_number,
            to_char(issue_date, 'YYYY-MM-DD') AS issue_date,
            grand_total_cents::text AS grand_total_cents,
            currency, peppol_status, peppol_message_id,
            vid_status, to_char(vid_due_date, 'YYYY-MM-DD') AS vid_due_date,
            journal_entry_id, created_at::text AS created_at,
            doc_type, corrected_invoice_number
       FROM einvoices
      WHERE ${where}
      ORDER BY issue_date DESC, created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return res.rows.map((r) => ({
    id: r.id,
    direction: r.direction,
    invoiceNumber: r.invoice_number,
    issueDate: r.issue_date,
    grandTotalCents: r.grand_total_cents,
    currency: r.currency,
    peppolStatus: r.peppol_status,
    peppolMessageId: r.peppol_message_id,
    vidStatus: r.vid_status,
    vidDueDate: r.vid_due_date,
    journalEntryId: r.journal_entry_id,
    createdAt: r.created_at,
    docType: r.doc_type,
    correctedInvoiceNumber: r.corrected_invoice_number,
  }));
}

export async function getEinvoiceUbl(
  tx: PoolClient,
  ctx: TenantContext,
  id: string,
): Promise<{ invoiceNumber: string; ublXml: string } | null> {
  const res = await tx.query(
    `SELECT invoice_number AS "invoiceNumber", ubl_xml AS "ublXml"
       FROM einvoices WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  return res.rows[0] ?? null;
}

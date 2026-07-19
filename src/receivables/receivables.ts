import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type ReceivableStatus = 'open' | 'partially_paid' | 'paid' | 'void';
export interface ReceivableRow {
  id: string; invoiceNumber: string; customerPartyId: string | null; issueDate: string;
  dueDate: string | null; currency: string; grandTotalCents: string; amountPaidCents: string;
  outstandingCents: string; status: ReceivableStatus | null;
}

const ROW_COLS = `
  id, invoice_number AS "invoiceNumber", customer_party_id AS "customerPartyId",
  to_char(issue_date,'YYYY-MM-DD') AS "issueDate", to_char(due_date,'YYYY-MM-DD') AS "dueDate",
  currency, grand_total_cents::text AS "grandTotalCents", amount_paid_cents::text AS "amountPaidCents",
  (grand_total_cents - amount_paid_cents)::text AS "outstandingCents", status`;

export async function getReceivable(tx: PoolClient, ctx: TenantContext, id: string): Promise<ReceivableRow> {
  const res = await tx.query(
    `SELECT ${ROW_COLS} FROM einvoices WHERE id = $1 AND client_company_id = $2 AND direction = 'outbound'`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Receivable not found: ${id}`);
  return res.rows[0];
}

export async function listReceivables(
  tx: PoolClient, ctx: TenantContext, filter: { status?: string } = {},
): Promise<ReceivableRow[]> {
  const res = await tx.query(
    `SELECT ${ROW_COLS} FROM einvoices
     WHERE client_company_id = $1 AND direction = 'outbound'
       AND ($2::text IS NULL OR status = $2)
     ORDER BY due_date ASC NULLS LAST, created_at ASC`,
    [ctx.clientCompanyId, filter.status ?? null],
  );
  return res.rows;
}

export async function voidReceivable(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  const r = await getReceivable(tx, ctx, id);
  if (r.status !== 'open') throw new Error(`Only an open receivable can be voided (status=${r.status})`);
  await tx.query(`UPDATE einvoices SET status = 'void' WHERE id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
  await appendAudit(tx, ctx, { action: 'void', entityType: 'receivable', entityId: id, before: { status: r.status }, after: { status: 'void' } });
}

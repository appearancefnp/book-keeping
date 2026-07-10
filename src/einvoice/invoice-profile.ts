import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export interface InvoiceProfileLine { description: string; net: string; vatRate: number }
export interface InvoiceProfile {
  paymentTerms: string | null;
  note: string | null;
  dueDateOffsetDays: number | null;
  numberPrefix: string | null;
  defaultLines: InvoiceProfileLine[];
  footer: string | null;
  logoBlobKey: string | null;
}

export async function getInvoiceProfile(tx: PoolClient, ctx: TenantContext): Promise<InvoiceProfile | null> {
  const res = await tx.query(
    `SELECT payment_terms AS "paymentTerms", note, due_date_offset_days AS "dueDateOffsetDays",
            number_prefix AS "numberPrefix", default_lines AS "defaultLines", footer, logo_blob_key AS "logoBlobKey"
     FROM invoice_profiles WHERE client_company_id = $1`,
    [ctx.clientCompanyId],
  );
  return res.rows[0] ?? null;
}

export async function setInvoiceProfile(tx: PoolClient, ctx: TenantContext, input: Omit<InvoiceProfile, 'logoBlobKey'>): Promise<void> {
  await tx.query(
    `INSERT INTO invoice_profiles(client_company_id, payment_terms, note, due_date_offset_days, number_prefix, default_lines, footer, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
     ON CONFLICT (client_company_id) DO UPDATE SET
       payment_terms = EXCLUDED.payment_terms, note = EXCLUDED.note,
       due_date_offset_days = EXCLUDED.due_date_offset_days, number_prefix = EXCLUDED.number_prefix,
       default_lines = EXCLUDED.default_lines, footer = EXCLUDED.footer,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [ctx.clientCompanyId, input.paymentTerms, input.note, input.dueDateOffsetDays,
     input.numberPrefix, JSON.stringify(input.defaultLines ?? []), input.footer, ctx.actorId],
  );
  await appendAudit(tx, ctx, {
    action: 'set', entityType: 'invoice_profile', entityId: ctx.clientCompanyId, before: null, after: input,
  });
}

export async function setInvoiceLogo(tx: PoolClient, ctx: TenantContext, key: string): Promise<void> {
  await tx.query(
    `INSERT INTO invoice_profiles(client_company_id, logo_blob_key, updated_by)
     VALUES ($1,$2,$3)
     ON CONFLICT (client_company_id) DO UPDATE SET logo_blob_key = EXCLUDED.logo_blob_key, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [ctx.clientCompanyId, key, ctx.actorId],
  );
  await appendAudit(tx, ctx, { action: 'set_logo', entityType: 'invoice_profile', entityId: ctx.clientCompanyId, before: null, after: { logoBlobKey: key } });
}

import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { EInvoice } from '../einvoice/ubl.js';
import { appendAudit } from '../audit/audit.js';
import { validateEn16931 } from '../einvoice/validate.js';
import { type VatCategory, VAT_CATEGORIES } from '../tax/categories.js';

export type RecurringInvoicePayload = Omit<EInvoice, 'invoiceNumber' | 'issueDate' | 'dueDate'>;

export interface RecurringTemplateRow {
  id: string;
  clientCompanyId: string;
  customerPartyId: string;
  recipientPeppolId: string;
  invoicePayload: RecurringInvoicePayload;
  anchorDay: number;
  intervalMonths: number;
  nextRunDate: string;
  paymentTermsDays: number | null;
  endDate: string | null;
  occurrencesRemaining: number | null;
  active: boolean;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const invoicePartySchema = z.object({ name: z.string().min(1), regNo: z.string(), vatNo: z.string() });
const invoiceLineSchema = z.object({
  description: z.string(), net: z.string(), vatRate: z.number(), vat: z.string(),
  /** BT-151; absent means 'S'. Runtime schema must carry this or it's silently stripped
   * before assertPayloadValid ever sees it — see categoryIssues in ../tax/categories.js. */
  vatCategory: z.enum(VAT_CATEGORIES as unknown as [VatCategory, ...VatCategory[]]).optional(),
});
const invoicePayloadSchema = z.object({
  currency: z.string(),
  supplier: invoicePartySchema,
  customer: invoicePartySchema,
  lines: z.array(invoiceLineSchema),
  netTotal: z.string(), vatTotal: z.string(), grandTotal: z.string(),
  note: z.string().optional(),
  paymentTerms: z.string().optional(),
}).passthrough();

/**
 * Runs the EN16931 business-rule check against a payload that lacks invoiceNumber/issueDate
 * (those are only known at bill time). Placeholders satisfy the validator's presence checks
 * so the remaining structural/arithmetic rules (currency, VAT, line totals) are still enforced.
 */
function assertPayloadValid(payload: RecurringInvoicePayload): void {
  const probe = { ...payload, invoiceNumber: '__probe__', issueDate: '__probe__' } as unknown as EInvoice;
  const v = validateEn16931(probe);
  if (!v.valid) throw new Error(`Invalid recurring invoice template payload: ${v.issues.join('; ')}`);
}

const createSchema = z.object({
  customerPartyId: z.string().uuid(),
  recipientPeppolId: z.string().min(1),
  invoicePayload: invoicePayloadSchema,
  anchorDay: z.number().int().min(1).max(31),
  intervalMonths: z.number().int().min(1),
  firstRunDate: isoDate,
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  endDate: isoDate.nullable().optional(),
  occurrencesRemaining: z.number().int().min(1).nullable().optional(),
});

const SELECT_COLS = `id, client_company_id AS "clientCompanyId", customer_party_id AS "customerPartyId",
  recipient_peppol_id AS "recipientPeppolId", invoice_payload AS "invoicePayload",
  anchor_day AS "anchorDay", interval_months AS "intervalMonths", next_run_date::text AS "nextRunDate",
  payment_terms_days AS "paymentTermsDays", end_date::text AS "endDate",
  occurrences_remaining AS "occurrencesRemaining", active`;

export async function createTemplate(
  tx: PoolClient, ctx: TenantContext, input: z.input<typeof createSchema>,
): Promise<{ id: string }> {
  const p = createSchema.parse(input);
  assertPayloadValid(p.invoicePayload);
  const res = await tx.query(
    `INSERT INTO recurring_invoice_templates
       (client_company_id, customer_party_id, recipient_peppol_id, invoice_payload,
        anchor_day, interval_months, next_run_date, payment_terms_days, end_date, occurrences_remaining)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [ctx.clientCompanyId, p.customerPartyId, p.recipientPeppolId, JSON.stringify(p.invoicePayload),
     p.anchorDay, p.intervalMonths, p.firstRunDate, p.paymentTermsDays ?? null,
     p.endDate ?? null, p.occurrencesRemaining ?? null],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'recurring_template', entityId: id, before: null, after: p });
  return { id };
}

export async function getTemplate(tx: PoolClient, ctx: TenantContext, id: string): Promise<RecurringTemplateRow> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM recurring_invoice_templates WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Recurring template not found: ${id}`);
  return res.rows[0];
}

export async function listTemplates(
  tx: PoolClient, ctx: TenantContext, filter: { active?: boolean } = {},
): Promise<RecurringTemplateRow[]> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM recurring_invoice_templates
     WHERE client_company_id = $1 AND ($2::boolean IS NULL OR active = $2)
     ORDER BY next_run_date ASC`,
    [ctx.clientCompanyId, filter.active ?? null],
  );
  return res.rows;
}

const patchSchema = z.object({
  invoicePayload: invoicePayloadSchema.optional(),
  recipientPeppolId: z.string().min(1).optional(),
  anchorDay: z.number().int().min(1).max(31).optional(),
  intervalMonths: z.number().int().min(1).optional(),
  nextRunDate: isoDate.optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  endDate: isoDate.nullable().optional(),
  occurrencesRemaining: z.number().int().min(1).nullable().optional(),
});

export async function updateTemplate(
  tx: PoolClient, ctx: TenantContext, id: string, patch: z.input<typeof patchSchema>,
): Promise<void> {
  const p = patchSchema.parse(patch);
  const before = await getTemplate(tx, ctx, id);
  const merged = {
    invoicePayload: p.invoicePayload ?? before.invoicePayload,
    recipientPeppolId: p.recipientPeppolId ?? before.recipientPeppolId,
    anchorDay: p.anchorDay ?? before.anchorDay,
    intervalMonths: p.intervalMonths ?? before.intervalMonths,
    nextRunDate: p.nextRunDate ?? before.nextRunDate,
    paymentTermsDays: p.paymentTermsDays !== undefined ? p.paymentTermsDays : before.paymentTermsDays,
    endDate: p.endDate !== undefined ? p.endDate : before.endDate,
    occurrencesRemaining: p.occurrencesRemaining !== undefined ? p.occurrencesRemaining : before.occurrencesRemaining,
  };
  assertPayloadValid(merged.invoicePayload);
  await tx.query(
    `UPDATE recurring_invoice_templates SET invoice_payload = $1::jsonb, recipient_peppol_id = $2,
       anchor_day = $3, interval_months = $4, next_run_date = $5, payment_terms_days = $6,
       end_date = $7, occurrences_remaining = $8, updated_at = now()
     WHERE id = $9 AND client_company_id = $10`,
    [JSON.stringify(merged.invoicePayload), merged.recipientPeppolId, merged.anchorDay,
     merged.intervalMonths, merged.nextRunDate, merged.paymentTermsDays, merged.endDate,
     merged.occurrencesRemaining, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'update', entityType: 'recurring_template', entityId: id, before, after: merged });
}

export async function deactivateTemplate(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  const before = await getTemplate(tx, ctx, id);
  await tx.query(
    `UPDATE recurring_invoice_templates SET active = false, updated_at = now()
     WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'deactivate', entityType: 'recurring_template', entityId: id, before, after: { active: false } });
}

/** Persist a schedule advance (used by generateDueRecurring). */
export async function advanceSchedule(
  tx: PoolClient, ctx: TenantContext, id: string,
  next: { nextRunDate: string; occurrencesRemaining: number | null; active: boolean },
): Promise<void> {
  const before = await getTemplate(tx, ctx, id);
  await tx.query(
    `UPDATE recurring_invoice_templates SET next_run_date = $1, occurrences_remaining = $2,
       active = $3, updated_at = now()
     WHERE id = $4 AND client_company_id = $5`,
    [next.nextRunDate, next.occurrencesRemaining, next.active, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'advance', entityType: 'recurring_template', entityId: id, before, after: next });
}

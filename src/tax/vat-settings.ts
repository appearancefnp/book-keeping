import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type Periodicity = 'monthly' | 'quarterly';
export const PERIODICITIES: readonly Periodicity[] = ['monthly', 'quarterly'];

export interface VatSettings { vatNo: string | null; periodicity: Periodicity }

/** Read the client's VAT settings, creating the default row (monthly, no VAT number) on first use. */
export async function getVatSettings(tx: PoolClient, ctx: TenantContext): Promise<VatSettings> {
  await tx.query(
    'INSERT INTO vat_settings(client_company_id) VALUES ($1) ON CONFLICT (client_company_id) DO NOTHING',
    [ctx.clientCompanyId],
  );
  const res = await tx.query(
    `SELECT vat_no AS "vatNo", periodicity FROM vat_settings WHERE client_company_id = $1`,
    [ctx.clientCompanyId],
  );
  return res.rows[0];
}

export async function setVatSettings(
  tx: PoolClient, ctx: TenantContext, next: { vatNo: string | null; periodicity: Periodicity },
): Promise<void> {
  if (!(PERIODICITIES as readonly string[]).includes(next.periodicity)) {
    throw new Error(`Invalid periodicity: "${next.periodicity}" (monthly or quarterly)`);
  }
  const vatNo = next.vatNo?.trim() ? next.vatNo.trim().toUpperCase() : null;

  const before = await getVatSettings(tx, ctx);
  await tx.query(
    `UPDATE vat_settings SET vat_no = $1, periodicity = $2, updated_at = now() WHERE client_company_id = $3`,
    [vatNo, next.periodicity, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: 'update', entityType: 'vat_settings', entityId: ctx.clientCompanyId,
    before, after: { vatNo, periodicity: next.periodicity },
  });
}

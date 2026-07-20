import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export interface ExpenseSettings { mileageRateCentsPerKm: string; }

/** Read the client's expense settings, creating the default row (30 cents/km) on first use. */
export async function getExpenseSettings(tx: PoolClient, ctx: TenantContext): Promise<ExpenseSettings> {
  await tx.query(
    'INSERT INTO expense_settings(client_company_id) VALUES ($1) ON CONFLICT (client_company_id) DO NOTHING',
    [ctx.clientCompanyId],
  );
  const res = await tx.query(
    `SELECT mileage_rate_cents_per_km::text AS "mileageRateCentsPerKm" FROM expense_settings WHERE client_company_id = $1`,
    [ctx.clientCompanyId],
  );
  return res.rows[0];
}

export async function setMileageRate(tx: PoolClient, ctx: TenantContext, rateCents: string): Promise<void> {
  if (!/^-?\d+$/.test(rateCents)) throw new Error(`Invalid mileage rate: "${rateCents}" (integer cents required)`);
  const rate = BigInt(rateCents);
  if (rate <= 0n) throw new Error('Mileage rate must be greater than zero');

  const before = await getExpenseSettings(tx, ctx);
  await tx.query(
    'UPDATE expense_settings SET mileage_rate_cents_per_km = $1 WHERE client_company_id = $2',
    [rate.toString(), ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: 'update', entityType: 'expense_settings', entityId: ctx.clientCompanyId,
    before, after: { mileageRateCentsPerKm: rate.toString() },
  });
}

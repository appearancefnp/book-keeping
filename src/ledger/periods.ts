import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export type PeriodStatus = 'open' | 'closed' | 'none';

export async function openPeriod(
  tx: PoolClient, ctx: TenantContext, p: { year: number; month: number },
): Promise<void> {
  await tx.query(
    `INSERT INTO accounting_periods(client_company_id, year, month, status)
     VALUES ($1,$2,$3,'open')
     ON CONFLICT (client_company_id, year, month) DO UPDATE SET status = 'open'`,
    [ctx.clientCompanyId, p.year, p.month],
  );
}

export async function closePeriod(
  tx: PoolClient, ctx: TenantContext, p: { year: number; month: number },
): Promise<void> {
  await tx.query(
    `UPDATE accounting_periods SET status = 'closed'
     WHERE client_company_id = $1 AND year = $2 AND month = $3`,
    [ctx.clientCompanyId, p.year, p.month],
  );
}

/** date is 'YYYY-MM-DD'. */
export async function periodStatusFor(
  tx: PoolClient, _ctx: TenantContext, date: string,
): Promise<PeriodStatus> {
  const [y, m] = date.split('-').map(Number);
  const res = await tx.query(
    'SELECT status FROM accounting_periods WHERE year = $1 AND month = $2',
    [y, m],
  );
  return (res.rows[0]?.status as PeriodStatus) ?? 'none';
}

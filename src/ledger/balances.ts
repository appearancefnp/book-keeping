import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface TrialBalanceRow { code: string; name: string; debit: string; credit: string; balance: string; }

export async function trialBalance(tx: PoolClient, ctx: TenantContext): Promise<TrialBalanceRow[]> {
  const res = await tx.query(`
    SELECT a.code, a.name,
           COALESCE(SUM(jl.debit), 0)::numeric(18,2)::text  AS debit,
           COALESCE(SUM(jl.credit), 0)::numeric(18,2)::text AS credit,
           (COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0))::numeric(18,2)::text AS balance
    FROM accounts a
    LEFT JOIN journal_lines jl ON jl.account_id = a.id
    WHERE a.client_company_id = $1
    GROUP BY a.code, a.name
    ORDER BY a.code
  `, [ctx.clientCompanyId]);
  return res.rows;
}

import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccountType } from './accounts.js';

export interface TrialBalanceRow { code: string; name: string; debit: string; credit: string; balance: string; }
export interface DatedBalanceRow extends TrialBalanceRow { type: AccountType; }

/**
 * Per-account debit/credit/balance, optionally bounded by entry_date.
 * `balance` is debit-normal: SUM(debit) - SUM(credit). Includes accounts with
 * no lines in range (zero rows). Ordered by code. RLS scopes journal rows;
 * accounts are additionally filtered by tenant to match trialBalance().
 */
export async function accountBalances(
  tx: PoolClient,
  ctx: TenantContext,
  range: { from?: string; to?: string } = {},
): Promise<DatedBalanceRow[]> {
  const res = await tx.query(`
    SELECT a.code, a.name, a.type,
           COALESCE(SUM(jl.debit), 0)::numeric(18,2)::text  AS debit,
           COALESCE(SUM(jl.credit), 0)::numeric(18,2)::text AS credit,
           (COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0))::numeric(18,2)::text AS balance
    FROM accounts a
    LEFT JOIN (
      SELECT l.account_id, l.debit, l.credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.entry_id
      WHERE ($2::date IS NULL OR e.entry_date >= $2::date)
        AND ($3::date IS NULL OR e.entry_date <= $3::date)
    ) jl ON jl.account_id = a.id
    WHERE a.client_company_id = $1
    GROUP BY a.code, a.name, a.type
    ORDER BY a.code
  `, [ctx.clientCompanyId, range.from ?? null, range.to ?? null]);
  return res.rows;
}

export async function trialBalance(tx: PoolClient, ctx: TenantContext): Promise<TrialBalanceRow[]> {
  return accountBalances(tx, ctx, {});
}

import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export interface AccountRow { id: string; code: string; name: string; type: AccountType; }

const newAccountSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(['asset', 'liability', 'equity', 'income', 'expense']),
});

export async function createAccount(
  tx: PoolClient,
  ctx: TenantContext,
  input: { code: string; name: string; type: AccountType },
): Promise<AccountRow> {
  const p = newAccountSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO accounts(client_company_id, code, name, type)
     VALUES ($1,$2,$3,$4) RETURNING id, code, name, type`,
    [ctx.clientCompanyId, p.code, p.name, p.type],
  );
  return res.rows[0];
}

export async function listAccounts(tx: PoolClient, _ctx: TenantContext): Promise<AccountRow[]> {
  const res = await tx.query('SELECT id, code, name, type FROM accounts ORDER BY code');
  return res.rows;
}

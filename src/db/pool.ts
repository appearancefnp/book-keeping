import { Pool, type PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export const adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL });
export const appPool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Runs `fn` inside a transaction on the APP pool with the tenant session var set,
 * so RLS restricts every statement to ctx.clientCompanyId. Rolls back on throw.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await appPool.connect();
  try {
    await tx.query('BEGIN');
    // set_config(..., true) = local to this transaction. Parameterized to avoid injection.
    await tx.query("SELECT set_config('app.current_client_id', $1, true)", [ctx.clientCompanyId]);
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (err) {
    await tx.query('ROLLBACK');
    throw err;
  } finally {
    tx.release();
  }
}

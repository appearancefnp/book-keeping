import { Pool, type PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

const poolConfig = { max: 5, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 };
export const adminPool = new Pool({ connectionString: process.env.ADMIN_DATABASE_URL, ...poolConfig });
export const appPool = new Pool({ connectionString: process.env.DATABASE_URL, ...poolConfig });
export const workerPool = new Pool({ connectionString: process.env.WORKER_DATABASE_URL, ...poolConfig });
export const supervisorPool = new Pool({ connectionString: process.env.SUPERVISOR_DATABASE_URL, ...poolConfig });

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

/**
 * Runs `fn` in a transaction on the WORKER pool (bookkeeping_worker). Used only for the
 * control plane — claiming and completing jobs across all tenants. Does NOT set
 * app.current_client_id; business work runs separately via withTenant on the app pool.
 */
export async function withWorker<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await workerPool.connect();
  try {
    await tx.query('BEGIN');
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

/**
 * Runs `fn` in a transaction on the SUPERVISOR pool (bookkeeping_supervisor). Used only by the
 * chain reaper: reads active drivers cross-tenant and seeds recovery jobs. Does NOT set
 * app.current_client_id.
 */
export async function withSupervisor<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const tx = await supervisorPool.connect();
  try {
    await tx.query('BEGIN');
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

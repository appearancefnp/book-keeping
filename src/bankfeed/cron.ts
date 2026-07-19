import { appPool, withTenant } from '../db/pool.js';
import type { TenantContext } from '../tenancy/context.js';
import type { BankFeedProvider } from './provider.js';
import { syncConnection } from './sync.js';

/** Cron has no session — a system actor so audit rows are honestly attributed. */
export function systemContext(firmId: string, clientCompanyId: string): TenantContext {
  return { firmId, clientCompanyId, actorId: 'system:bank-sync', actorRole: 'agent' };
}

/**
 * Daily sweep: sync every linked connection of every client. client_companies has
 * no RLS; each connection syncs in its own withTenant transaction so one failure
 * (recorded on the connection) never rolls back or blocks the others.
 */
export async function syncAllClients(provider: BankFeedProvider, todayIso: string): Promise<{ synced: number; failed: number }> {
  const clients = await appPool.query(`SELECT id, firm_id AS "firmId" FROM client_companies ORDER BY created_at`);
  let synced = 0; let failed = 0;
  for (const c of clients.rows) {
    const ctx = systemContext(c.firmId as string, c.id as string);
    const conns = await withTenant(ctx, async (tx) =>
      (await tx.query(`SELECT id FROM bank_feed_connections WHERE status = 'linked' ORDER BY created_at`)).rows as { id: string }[]);
    for (const conn of conns) {
      try {
        await withTenant(ctx, (tx) => syncConnection(tx, ctx, provider, conn.id, todayIso));
        synced++;
      } catch (err) {
        failed++;
        const msg = err instanceof Error ? err.message : String(err);
        await withTenant(ctx, (tx) =>
          tx.query(`UPDATE bank_feed_connections SET last_error = $1, updated_at = now() WHERE id = $2`, [msg, conn.id]),
        ).catch(() => { /* recording the error must not kill the sweep */ });
      }
    }
  }
  return { synced, failed };
}

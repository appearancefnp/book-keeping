import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface NotificationRow { id: string; kind: string; message: string; read: boolean; createdAt: string; }

export async function notify(tx: PoolClient, ctx: TenantContext, input: { recipient: string; kind: string; message: string }): Promise<{ id: string }> {
  const res = await tx.query(
    `INSERT INTO notifications(client_company_id, recipient, kind, message) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.clientCompanyId, input.recipient, input.kind, input.message],
  );
  return { id: res.rows[0].id };
}
export async function listNotifications(tx: PoolClient, ctx: TenantContext, recipient: string, opts: { unreadOnly?: boolean; limit?: number; offset?: number } = {}): Promise<NotificationRow[]> {
  // LIMIT NULL / OFFSET NULL are no-ops in Postgres, so omitted paging keeps the old behavior.
  const res = await tx.query(
    `SELECT id, kind, message, read, to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt" FROM notifications
     WHERE client_company_id = $1 AND recipient = $2 AND ($3::boolean IS NOT TRUE OR read = false)
     ORDER BY created_at DESC
     LIMIT $4::int OFFSET $5::int`,
    [ctx.clientCompanyId, recipient, opts.unreadOnly ?? false, opts.limit ?? null, opts.offset ?? null],
  );
  return res.rows;
}
export async function markRead(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  await tx.query(`UPDATE notifications SET read = true WHERE id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
}
export async function markAllRead(tx: PoolClient, ctx: TenantContext, recipient: string): Promise<void> {
  await tx.query(
    `UPDATE notifications SET read = true
     WHERE client_company_id = $1 AND recipient = $2 AND read = false`,
    [ctx.clientCompanyId, recipient],
  );
}

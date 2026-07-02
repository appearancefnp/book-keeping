import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface NotificationRow { id: string; kind: string; message: string; read: boolean; }

export async function notify(tx: PoolClient, ctx: TenantContext, input: { recipient: string; kind: string; message: string }): Promise<{ id: string }> {
  const res = await tx.query(
    `INSERT INTO notifications(client_company_id, recipient, kind, message) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.clientCompanyId, input.recipient, input.kind, input.message],
  );
  return { id: res.rows[0].id };
}
export async function listNotifications(tx: PoolClient, ctx: TenantContext, recipient: string, opts: { unreadOnly?: boolean } = {}): Promise<NotificationRow[]> {
  const res = await tx.query(
    `SELECT id, kind, message, read FROM notifications
     WHERE client_company_id = $1 AND recipient = $2 AND ($3::boolean IS NOT TRUE OR read = false)
     ORDER BY created_at DESC`,
    [ctx.clientCompanyId, recipient, opts.unreadOnly ?? false],
  );
  return res.rows;
}
export async function markRead(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  await tx.query(`UPDATE notifications SET read = true WHERE id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
}

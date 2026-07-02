import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export async function registerDeviceToken(
  tx: PoolClient, ctx: TenantContext, input: { token: string; platform: 'ios' | 'android' },
): Promise<{ id: string | null }> {
  const res = await tx.query(
    `INSERT INTO device_tokens(client_company_id, owner, token, platform)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (client_company_id, token) DO NOTHING
     RETURNING id`,
    [ctx.clientCompanyId, ctx.actorId, input.token, input.platform],
  );
  return { id: res.rows[0]?.id ?? null };
}

export async function listDeviceTokens(tx: PoolClient, ctx: TenantContext): Promise<{ token: string; platform: string }[]> {
  const res = await tx.query(
    `SELECT token, platform FROM device_tokens WHERE client_company_id = $1 ORDER BY created_at`,
    [ctx.clientCompanyId],
  );
  return res.rows;
}

/** Unread notifications joined to the recipient's device tokens — the work list a push worker would send. */
export async function pendingPushNotifications(
  tx: PoolClient, ctx: TenantContext,
): Promise<{ token: string; platform: string; message: string }[]> {
  const res = await tx.query(
    `SELECT d.token, d.platform, n.message
     FROM notifications n
     JOIN device_tokens d ON d.owner = n.recipient AND d.client_company_id = n.client_company_id
     WHERE n.client_company_id = $1 AND n.read = false
     ORDER BY n.created_at`,
    [ctx.clientCompanyId],
  );
  return res.rows;
}

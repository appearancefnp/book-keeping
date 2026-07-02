import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface CommentRow { id: string; author: string; body: string; }

export async function addComment(tx: PoolClient, ctx: TenantContext, input: { entityType: string; entityId: string; body: string }): Promise<{ id: string }> {
  const res = await tx.query(
    `INSERT INTO comments(client_company_id, entity_type, entity_id, author, body) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.clientCompanyId, input.entityType, input.entityId, ctx.actorId, input.body],
  );
  return { id: res.rows[0].id };
}
export async function listComments(tx: PoolClient, ctx: TenantContext, entityType: string, entityId: string): Promise<CommentRow[]> {
  const res = await tx.query(
    `SELECT id, author, body FROM comments
     WHERE client_company_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY created_at, id`,
    [ctx.clientCompanyId, entityType, entityId],
  );
  return res.rows;
}

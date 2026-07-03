import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface ChatMessageRow { id: string; role: 'user' | 'assistant'; content: string; citations: string[] }

export async function appendChatMessage(
  tx: PoolClient, ctx: TenantContext,
  input: { threadId: string; role: 'user' | 'assistant'; content: string; citations: string[] },
): Promise<{ id: string }> {
  const res = await tx.query(
    `INSERT INTO chat_messages(client_company_id, thread_id, role, content, citations, author)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.clientCompanyId, input.threadId, input.role, input.content, JSON.stringify(input.citations), ctx.actorId],
  );
  return { id: res.rows[0].id };
}

export async function listThread(tx: PoolClient, ctx: TenantContext, threadId: string): Promise<ChatMessageRow[]> {
  const res = await tx.query(
    `SELECT id, role, content, citations FROM chat_messages
     WHERE client_company_id = $1 AND thread_id = $2 ORDER BY seq`,
    [ctx.clientCompanyId, threadId],
  );
  return res.rows;
}

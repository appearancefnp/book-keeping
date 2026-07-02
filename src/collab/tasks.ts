import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export interface TaskRow { id: string; title: string; detail: string; status: 'open' | 'resolved'; }

export async function createTask(tx: PoolClient, ctx: TenantContext, input: { title: string; detail?: string }): Promise<{ id: string }> {
  const res = await tx.query(
    `INSERT INTO tasks(client_company_id, title, detail, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.clientCompanyId, input.title, input.detail ?? '', ctx.actorId],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'task', entityId: id, before: null, after: { title: input.title } });
  return { id };
}
export async function listTasks(tx: PoolClient, ctx: TenantContext, filter: { status?: 'open' | 'resolved' } = {}): Promise<TaskRow[]> {
  const res = await tx.query(
    `SELECT id, title, detail, status FROM tasks
     WHERE client_company_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at`,
    [ctx.clientCompanyId, filter.status ?? null],
  );
  return res.rows;
}
export async function resolveTask(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  const res = await tx.query(`UPDATE tasks SET status = 'resolved' WHERE id = $1 AND client_company_id = $2`, [id, ctx.clientCompanyId]);
  if (!res.rowCount) throw new Error(`Task not found: ${id}`);
  await appendAudit(tx, ctx, { action: 'resolve', entityType: 'task', entityId: id, before: null, after: { status: 'resolved' } });
}

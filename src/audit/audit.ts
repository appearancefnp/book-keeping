import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown | null;
  after: unknown | null;
}

export async function appendAudit(tx: PoolClient, ctx: TenantContext, a: AuditInput): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log(client_company_id, actor_id, actor_role, action, entity_type, entity_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      ctx.clientCompanyId, ctx.actorId, ctx.actorRole, a.action, a.entityType, a.entityId,
      a.before === null ? null : JSON.stringify(a.before),
      a.after === null ? null : JSON.stringify(a.after),
    ],
  );
}

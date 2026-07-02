import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface AuditRow { action: string; entityType: string; entityId: string | null; actorId: string; createdAt: string; }

export async function listAuditLog(tx: PoolClient, ctx: TenantContext, filter: { entityType?: string; entityId?: string } = {}): Promise<AuditRow[]> {
  const res = await tx.query(
    `SELECT action, entity_type AS "entityType", entity_id AS "entityId", actor_id AS "actorId", to_char(created_at,'YYYY-MM-DD"T"HH24:MI:SSZ') AS "createdAt"
     FROM audit_log
     WHERE client_company_id = $1
       AND ($2::text IS NULL OR entity_type = $2)
       AND ($3::uuid IS NULL OR entity_id = $3)
     ORDER BY created_at DESC LIMIT 500`,
    [ctx.clientCompanyId, filter.entityType ?? null, filter.entityId ?? null],
  );
  return res.rows;
}

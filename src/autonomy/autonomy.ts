import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type AutonomyMode = 'auto' | 'approval';

/** Operation types that may NEVER auto-execute, regardless of policy. */
const ALWAYS_APPROVAL = new Set(['declaration']);

export async function setAutonomy(
  tx: PoolClient, ctx: TenantContext,
  input: { operationType: string; mode: AutonomyMode; materialThresholdCents?: bigint },
): Promise<void> {
  await tx.query(
    `INSERT INTO autonomy_policy(client_company_id, operation_type, mode, material_threshold_cents)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (client_company_id, operation_type)
     DO UPDATE SET mode = EXCLUDED.mode, material_threshold_cents = EXCLUDED.material_threshold_cents`,
    [ctx.clientCompanyId, input.operationType, input.mode, (input.materialThresholdCents ?? 100000n).toString()],
  );
  await appendAudit(tx, ctx, { action: 'set', entityType: 'autonomy_policy', entityId: null, before: null, after: {
    operationType: input.operationType,
    mode: input.mode,
    materialThresholdCents: (input.materialThresholdCents ?? 100000n).toString(),
  } });
}

export async function resolveAutonomy(
  tx: PoolClient, ctx: TenantContext, operationType: string, opts: { amountCents: bigint },
): Promise<AutonomyMode> {
  if (ALWAYS_APPROVAL.has(operationType)) return 'approval';

  const res = await tx.query(
    `SELECT mode, material_threshold_cents AS "threshold"
     FROM autonomy_policy WHERE client_company_id = $1 AND operation_type = $2`,
    [ctx.clientCompanyId, operationType],
  );
  const row = res.rows[0];
  if (!row || row.mode !== 'auto') return 'approval';       // default-closed
  if (opts.amountCents >= BigInt(row.threshold)) return 'approval'; // material-sum guardrail
  return 'auto';
}

export interface AutonomyPolicyRow {
  operationType: string;
  mode: AutonomyMode;
  materialThresholdCents: string;
}

export async function listAutonomyPolicies(tx: PoolClient, ctx: TenantContext): Promise<AutonomyPolicyRow[]> {
  const res = await tx.query(
    `SELECT operation_type, mode, material_threshold_cents::text AS material_threshold_cents
       FROM autonomy_policy
      WHERE client_company_id = $1
      ORDER BY operation_type`,
    [ctx.clientCompanyId],
  );
  return res.rows.map((r) => ({
    operationType: r.operation_type,
    mode: r.mode,
    materialThresholdCents: r.material_threshold_cents,
  }));
}

import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export interface Stage { level: number; daysOverdue: number }
export interface DunningPolicy { enabled: boolean; lateFeeAnnualBps: number; lateFeeFlatCents: string }

/** Built-in escalation used when a client has not configured its own stages. */
export const DEFAULT_STAGES: Stage[] = [
  { level: 1, daysOverdue: 1 },
  { level: 2, daysOverdue: 15 },
  { level: 3, daysOverdue: 30 },
];

export async function getDunningPolicy(tx: PoolClient, ctx: TenantContext): Promise<DunningPolicy> {
  const res = await tx.query(
    `SELECT enabled, late_fee_annual_bps AS "lateFeeAnnualBps", late_fee_flat_cents::text AS "lateFeeFlatCents"
       FROM dunning_policy WHERE client_company_id = $1`,
    [ctx.clientCompanyId],
  );
  if (!res.rowCount) return { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' };
  return res.rows[0];
}

export async function setDunningPolicy(
  tx: PoolClient, ctx: TenantContext,
  input: { enabled: boolean; lateFeeAnnualBps: number; lateFeeFlatCents: string },
): Promise<void> {
  if (input.lateFeeAnnualBps < 0) throw new Error('lateFeeAnnualBps must be non-negative');
  if (BigInt(input.lateFeeFlatCents) < 0n) throw new Error('lateFeeFlatCents must be non-negative');
  await tx.query(
    `INSERT INTO dunning_policy(client_company_id, enabled, late_fee_annual_bps, late_fee_flat_cents)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (client_company_id)
     DO UPDATE SET enabled = EXCLUDED.enabled,
                   late_fee_annual_bps = EXCLUDED.late_fee_annual_bps,
                   late_fee_flat_cents = EXCLUDED.late_fee_flat_cents`,
    [ctx.clientCompanyId, input.enabled, input.lateFeeAnnualBps, input.lateFeeFlatCents],
  );
  await appendAudit(tx, ctx, { action: 'set', entityType: 'dunning_policy', entityId: null, before: null, after: input });
}

export async function listStages(tx: PoolClient, ctx: TenantContext): Promise<Stage[]> {
  const res = await tx.query(
    `SELECT level, days_overdue AS "daysOverdue" FROM dunning_stages
      WHERE client_company_id = $1 ORDER BY level ASC`,
    [ctx.clientCompanyId],
  );
  return res.rowCount ? res.rows : DEFAULT_STAGES;
}

export async function setStages(tx: PoolClient, ctx: TenantContext, stages: Stage[]): Promise<void> {
  const levels = stages.map((s) => s.level);
  if (new Set(levels).size !== levels.length) throw new Error('Stage levels must be distinct');
  for (const s of stages) {
    if (s.daysOverdue < 0) throw new Error('Stage days_overdue must be non-negative');
  }
  const byLevel = [...stages].sort((a, b) => a.level - b.level);
  for (let i = 1; i < byLevel.length; i++) {
    if (byLevel[i]!.daysOverdue <= byLevel[i - 1]!.daysOverdue) {
      throw new Error('Stage days_overdue must be strictly ascending by level');
    }
  }
  await tx.query(`DELETE FROM dunning_stages WHERE client_company_id = $1`, [ctx.clientCompanyId]);
  for (const s of byLevel) {
    await tx.query(
      `INSERT INTO dunning_stages(client_company_id, level, days_overdue) VALUES ($1,$2,$3)`,
      [ctx.clientCompanyId, s.level, s.daysOverdue],
    );
  }
  await appendAudit(tx, ctx, { action: 'set', entityType: 'dunning_stages', entityId: null, before: null, after: { stages: byLevel } });
}

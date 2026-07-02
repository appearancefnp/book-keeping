import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getProposal, type ProposalStatus } from './proposals.js';
import { appendAudit } from '../audit/audit.js';

async function transition(
  tx: PoolClient, ctx: TenantContext, id: string, from: ProposalStatus, to: ProposalStatus,
  extra: { rejectReason?: string } = {},
): Promise<void> {
  const before = await getProposal(tx, ctx, id);
  if (before.status !== from) {
    throw new Error(`Invalid transition for proposal ${id}: expected status ${from}, found ${before.status}`);
  }
  await tx.query(
    `UPDATE proposals
     SET status = $1, reject_reason = $2, resolved_by = $3, resolved_at = now()
     WHERE id = $4 AND client_company_id = $5`,
    [to, extra.rejectReason ?? null, ctx.actorId, id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: to, entityType: 'proposal', entityId: id,
    before: { status: before.status }, after: { status: to, ...(extra.rejectReason ? { rejectReason: extra.rejectReason } : {}) },
  });
}

export async function submitForApproval(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  await transition(tx, ctx, id, 'suggested', 'pending_approval');
}

export async function approveProposal(tx: PoolClient, ctx: TenantContext, id: string): Promise<void> {
  await transition(tx, ctx, id, 'pending_approval', 'approved');
}

export async function rejectProposal(tx: PoolClient, ctx: TenantContext, id: string, reason: string): Promise<void> {
  await transition(tx, ctx, id, 'pending_approval', 'rejected', { rejectReason: reason });
}

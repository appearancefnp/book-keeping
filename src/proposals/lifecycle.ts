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
  const prop = await getProposal(tx, ctx, id);
  await transition(tx, ctx, id, 'pending_approval', 'rejected', { rejectReason: reason });
  // A rejected bank match must free the reserved bank transaction so the next
  // propose run can re-propose it (HANDOFF finding: reject left it stuck 'matched').
  // All bank_match payload variants carry bankTransactionId.
  if (prop.type === 'bank_match') {
    const bankTransactionId = (prop.payload as { bankTransactionId?: string }).bankTransactionId;
    if (bankTransactionId) {
      await tx.query(
        `UPDATE bank_transactions SET status = 'unmatched'
         WHERE id = $1 AND client_company_id = $2 AND status = 'matched'`,
        [bankTransactionId, ctx.clientCompanyId],
      );
    }
  }
  // A rejected claim proposal sends the claim back to draft for correction.
  if (prop.type === 'posting') {
    await tx.query(
      `UPDATE expense_claims SET status = 'draft', posting_proposal_id = NULL
       WHERE posting_proposal_id = $1 AND client_company_id = $2 AND status = 'submitted'`,
      [id, ctx.clientCompanyId],
    );
  }
}

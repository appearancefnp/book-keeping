import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getProposal } from './proposals.js';
import { postEntry, type NewJournalEntry } from '../ledger/posting.js';
import { appendAudit } from '../audit/audit.js';

export async function postApprovedPosting(
  tx: PoolClient, ctx: TenantContext, proposalId: string,
): Promise<{ entryId: string }> {
  const prop = await getProposal(tx, ctx, proposalId);
  if (prop.type !== 'posting') throw new Error(`Proposal ${proposalId} is not a posting proposal (type=${prop.type})`);
  if (prop.status !== 'approved') throw new Error(`Proposal ${proposalId} must be approved before posting (status=${prop.status})`);

  // The payload is a NewJournalEntry; carry the source document through to the ledger.
  const entryInput = { ...(prop.payload as NewJournalEntry), sourceDocumentId: prop.documentId ?? null };
  const { entryId } = await postEntry(tx, ctx, entryInput);

  // Mark the proposal posted (lifecycle fields only — core fields stay immutable).
  await tx.query(
    `UPDATE proposals SET status = 'posted', resolved_entry_id = $1, resolved_by = $2, resolved_at = now()
     WHERE id = $3 AND client_company_id = $4`,
    [entryId, ctx.actorId, proposalId, ctx.clientCompanyId],
  );

  // Link + advance the source document, if any.
  if (prop.documentId) {
    await tx.query(
      `UPDATE documents SET journal_entry_id = $1, status = 'posted', updated_at = now()
       WHERE id = $2 AND client_company_id = $3`,
      [entryId, prop.documentId, ctx.clientCompanyId],
    );
  }

  // Link + open a payables bill, if this posting proposal originated from one.
  await tx.query(
    `UPDATE bills SET journal_entry_id = $1, status = 'open'
     WHERE posting_proposal_id = $2 AND client_company_id = $3 AND status = 'awaiting_approval'`,
    [entryId, proposalId, ctx.clientCompanyId],
  );

  // Link + apply a vendor credit note, if this posting proposal originated from one.
  await tx.query(
    `UPDATE vendor_credit_notes SET journal_entry_id = $1, status = 'applied'
     WHERE posting_proposal_id = $2 AND client_company_id = $3 AND status = 'awaiting_approval'`,
    [entryId, proposalId, ctx.clientCompanyId],
  );

  await appendAudit(tx, ctx, {
    action: 'posted', entityType: 'proposal', entityId: proposalId,
    before: { status: 'approved' }, after: { status: 'posted', entryId },
  });
  return { entryId };
}

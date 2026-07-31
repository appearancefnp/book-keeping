import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccessPoint } from '../einvoice/access-point.js';
import type { EInvoice } from '../einvoice/ubl.js';
import { getProposal } from '../proposals/proposals.js';
import { sendInvoice } from '../einvoice/outbound.js';
import { getAccessPoint } from '../einvoice/access-point-factory.js';
import { outboundInvoiceAccounts } from '../einvoice/accounts.js';
import { appendAudit } from '../audit/audit.js';

interface RecurringInvoiceProposalPayload {
  invoice: EInvoice;
  recipientPeppolId: string;
  customerPartyId: string | null;
  dueDate: string | null;
}

/**
 * Issue the invoice held by an approved `recurring_invoice` proposal.
 *
 * generateDueRecurring gates on autonomy: 'auto' sends inline, anything else parks the invoice in
 * a pending_approval proposal. resolveAutonomy is default-closed, so the approval branch is what a
 * client gets with no policy row — this function is that branch's terminus.
 *
 * Caller contract mirrors postApprovedPosting / postApprovedBankMatch: approveProposal runs first,
 * in the same transaction. A throw here rolls the approval back with it, leaving the proposal
 * pending_approval and retryable rather than approved-but-unissued.
 */
export async function postApprovedRecurringInvoice(
  tx: PoolClient, ctx: TenantContext, proposalId: string,
  opts: { ap?: AccessPoint } = {},
): Promise<{ entryId: string }> {
  const prop = await getProposal(tx, ctx, proposalId);
  if (prop.type !== 'recurring_invoice') {
    throw new Error(`Proposal ${proposalId} is not a recurring invoice proposal (type=${prop.type})`);
  }
  if (prop.status !== 'approved') {
    throw new Error(`Proposal ${proposalId} must be approved before issuing (status=${prop.status})`);
  }

  const payload = prop.payload as RecurringInvoiceProposalPayload;
  const accounts = outboundInvoiceAccounts();
  const { einvoiceId, entryId, messageId } = await sendInvoice(tx, ctx, {
    invoice: payload.invoice,
    recipientPeppolId: payload.recipientPeppolId,
    ap: opts.ap ?? getAccessPoint(),
    receivableAccount: accounts.receivable,
    salesAccount: accounts.sales,
    vatAccount: accounts.vat,
    customerPartyId: payload.customerPartyId ?? null,
    dueDate: payload.dueDate ?? null,
  });

  // Lifecycle fields only — core proposal fields stay immutable, same as postApprovedPosting.
  await tx.query(
    `UPDATE proposals SET status = 'posted', resolved_entry_id = $1, resolved_by = $2, resolved_at = now()
     WHERE id = $3 AND client_company_id = $4`,
    [entryId, ctx.actorId, proposalId, ctx.clientCompanyId],
  );

  await appendAudit(tx, ctx, {
    action: 'posted', entityType: 'proposal', entityId: proposalId,
    before: { status: 'approved' }, after: { status: 'posted', entryId, einvoiceId, messageId },
  });
  return { entryId };
}

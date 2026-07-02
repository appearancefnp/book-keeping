import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getProposal } from '../proposals/proposals.js';
import { postEntry } from '../ledger/posting.js';
import { centsToDecimal } from '../tax/money-format.js';
import { appendAudit } from '../audit/audit.js';

export async function postApprovedBankMatch(
  tx: PoolClient, ctx: TenantContext, proposalId: string,
): Promise<{ entryId: string }> {
  const prop = await getProposal(tx, ctx, proposalId);
  if (prop.type !== 'bank_match') throw new Error(`Proposal ${proposalId} is not a bank_match (type=${prop.type})`);
  if (prop.status !== 'approved') throw new Error(`Proposal ${proposalId} must be approved before posting (status=${prop.status})`);

  const payload = prop.payload as { bankTransactionId: string; amountCents: string; bankAccount: string; receivablesAccount: string };
  const amount = centsToDecimal(payload.amountCents);

  // Settlement: DR bank / CR receivable. Use the bank transaction's booking date.
  const bt = await tx.query(
    `SELECT to_char(booking_date,'YYYY-MM-DD') AS "bookingDate", currency FROM bank_transactions WHERE id = $1 AND client_company_id = $2`,
    [payload.bankTransactionId, ctx.clientCompanyId],
  );
  if (!bt.rowCount) throw new Error(`Bank transaction not found: ${payload.bankTransactionId}`);
  const { bookingDate, currency } = bt.rows[0];

  const { entryId } = await postEntry(tx, ctx, {
    date: bookingDate, memo: `Bank settlement (match ${proposalId})`, currency,
    lines: [
      { accountCode: payload.bankAccount, debit: amount, credit: '0', description: 'Bank receipt' },
      { accountCode: payload.receivablesAccount, debit: '0', credit: amount, description: 'Settle receivable' },
    ],
  });

  await tx.query(
    `UPDATE proposals SET status = 'posted', resolved_entry_id = $1, resolved_by = $2, resolved_at = now()
     WHERE id = $3 AND client_company_id = $4`,
    [entryId, ctx.actorId, proposalId, ctx.clientCompanyId],
  );
  await tx.query(
    `UPDATE bank_transactions SET status = 'reconciled', matched_entry_id = $1 WHERE id = $2 AND client_company_id = $3`,
    [entryId, payload.bankTransactionId, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, { action: 'posted', entityType: 'bank_match', entityId: proposalId, before: { status: 'approved' }, after: { status: 'posted', entryId } });
  return { entryId };
}

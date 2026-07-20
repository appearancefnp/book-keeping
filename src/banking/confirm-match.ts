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

  const raw = prop.payload as { kind?: string; bankTransactionId: string; amountCents: string };

  // Read the bank transaction's booking date once (shared by all branches).
  const btRes = await tx.query(
    `SELECT to_char(booking_date,'YYYY-MM-DD') AS "bookingDate", currency FROM bank_transactions WHERE id = $1 AND client_company_id = $2`,
    [raw.bankTransactionId, ctx.clientCompanyId],
  );
  if (!btRes.rowCount) throw new Error(`Bank transaction not found: ${raw.bankTransactionId}`);
  const { bookingDate, currency } = btRes.rows[0];
  const amountDec = centsToDecimal(raw.amountCents);

  if (raw.kind === 'payable_clearing') {
    const p = prop.payload as { payRunId: string; bankAccount: string; bankClearingAccount: string };
    // Re-verify the run's uncleared payments still SUM to the proposed amount (guards
    // against the run changing between proposal and post).
    const sumRes = await tx.query(
      `SELECT COALESCE(SUM(amount_cents), 0)::text AS "sumCents"
       FROM bill_payments
       WHERE pay_run_id = $1 AND client_company_id = $2 AND method = 'pay_run' AND cleared_at IS NULL`,
      [p.payRunId, ctx.clientCompanyId],
    );
    if (BigInt(sumRes.rows[0].sumCents) !== BigInt(raw.amountCents)) {
      throw new Error(`Pay run ${p.payRunId} uncleared total ${sumRes.rows[0].sumCents} != proposed ${raw.amountCents} (already cleared or changed)`);
    }
    const { entryId } = await postEntry(tx, ctx, {
      date: bookingDate, memo: `Clear pay-run transit (match ${proposalId})`, currency,
      lines: [
        { accountCode: p.bankClearingAccount, debit: amountDec, credit: '0', description: 'Clear transit' },
        { accountCode: p.bankAccount, debit: '0', credit: amountDec, description: 'Bank payment' },
      ],
    });
    // Clear ALL uncleared payments of the run at once; guard guarantees a run clears at
    // most once (a concurrent/duplicate post finds nothing to clear and throws).
    const cleared = await tx.query(
      `UPDATE bill_payments SET cleared_at = now()
       WHERE pay_run_id = $1 AND client_company_id = $2 AND method = 'pay_run' AND cleared_at IS NULL`,
      [p.payRunId, ctx.clientCompanyId],
    );
    if (!cleared.rowCount) throw new Error(`Pay run ${p.payRunId} has no uncleared payments (already cleared)`);
    await tx.query(`UPDATE proposals SET status='posted', resolved_entry_id=$1, resolved_by=$2, resolved_at=now() WHERE id=$3 AND client_company_id=$4`, [entryId, ctx.actorId, proposalId, ctx.clientCompanyId]);
    await tx.query(`UPDATE bank_transactions SET status='reconciled', matched_entry_id=$1 WHERE id=$2 AND client_company_id=$3`, [entryId, raw.bankTransactionId, ctx.clientCompanyId]);
    await appendAudit(tx, ctx, { action: 'posted', entityType: 'bank_match', entityId: proposalId, before: { status: 'approved' }, after: { status: 'posted', entryId, kind: 'payable_clearing', payRunId: p.payRunId, cleared: cleared.rowCount } });
    return { entryId };
  }

  if (raw.kind === 'payable_direct') {
    const p = prop.payload as { billId: string; payablesAccount: string; bankAccount: string };
    const { settleBill } = await import('../payables/settlement.js');
    const { entryId } = await settleBill(tx, ctx, {
      billId: p.billId, amountCents: raw.amountCents, paidDate: bookingDate, method: 'bank_match',
      payablesAccount: p.payablesAccount, creditAccount: p.bankAccount, bankTransactionId: raw.bankTransactionId,
    });
    await tx.query(`UPDATE proposals SET status='posted', resolved_entry_id=$1, resolved_by=$2, resolved_at=now() WHERE id=$3 AND client_company_id=$4`, [entryId, ctx.actorId, proposalId, ctx.clientCompanyId]);
    await tx.query(`UPDATE bank_transactions SET status='reconciled', matched_entry_id=$1 WHERE id=$2 AND client_company_id=$3`, [entryId, raw.bankTransactionId, ctx.clientCompanyId]);
    await appendAudit(tx, ctx, { action: 'posted', entityType: 'bank_match', entityId: proposalId, before: { status: 'approved' }, after: { status: 'posted', entryId, kind: 'payable_direct' } });
    return { entryId };
  }

  if (raw.kind === 'expense_direct') {
    const p = prop.payload as { claimId: string; bankAccount: string; settlementAccount: string };
    const { settleClaim } = await import('../expenses/reimburse.js');
    const { entryId } = await settleClaim(tx, ctx, {
      claimId: p.claimId, paidDate: bookingDate, method: 'bank_match',
      bankTransactionId: raw.bankTransactionId, bankAccount: p.bankAccount, settlementAccount: p.settlementAccount,
    });
    await tx.query(`UPDATE proposals SET status='posted', resolved_entry_id=$1, resolved_by=$2, resolved_at=now() WHERE id=$3 AND client_company_id=$4`, [entryId, ctx.actorId, proposalId, ctx.clientCompanyId]);
    await tx.query(`UPDATE bank_transactions SET status='reconciled', matched_entry_id=$1 WHERE id=$2 AND client_company_id=$3`, [entryId, raw.bankTransactionId, ctx.clientCompanyId]);
    await appendAudit(tx, ctx, { action: 'posted', entityType: 'bank_match', entityId: proposalId, before: { status: 'approved' }, after: { status: 'posted', entryId, kind: 'expense_direct' } });
    return { entryId };
  }

  if (raw.kind === 'receivable_direct') {
    const p = prop.payload as { einvoiceId: string; receivableAccount: string; bankAccount: string };
    const { settleReceivable } = await import('../receivables/settlement.js');
    const { entryId } = await settleReceivable(tx, ctx, {
      einvoiceId: p.einvoiceId, amountCents: raw.amountCents, paidDate: bookingDate, method: 'bank_match',
      bankTransactionId: raw.bankTransactionId, bankAccount: p.bankAccount, receivableAccount: p.receivableAccount,
    });
    await tx.query(`UPDATE proposals SET status='posted', resolved_entry_id=$1, resolved_by=$2, resolved_at=now() WHERE id=$3 AND client_company_id=$4`, [entryId, ctx.actorId, proposalId, ctx.clientCompanyId]);
    await tx.query(`UPDATE bank_transactions SET status='reconciled', matched_entry_id=$1 WHERE id=$2 AND client_company_id=$3`, [entryId, raw.bankTransactionId, ctx.clientCompanyId]);
    await appendAudit(tx, ctx, { action: 'posted', entityType: 'bank_match', entityId: proposalId, before: { status: 'approved' }, after: { status: 'posted', entryId, kind: 'receivable_direct' } });
    return { entryId };
  }

  const payload = prop.payload as { bankTransactionId: string; amountCents: string; bankAccount: string; receivablesAccount: string };
  const amount = centsToDecimal(payload.amountCents);

  // Settlement: DR bank / CR receivable. Booking date/currency already fetched above.
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

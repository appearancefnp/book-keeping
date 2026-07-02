import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';

export interface MatchConfig { receivablesAccount: string; bankAccount: string; }

export async function proposeMatches(
  tx: PoolClient, ctx: TenantContext, config: MatchConfig,
): Promise<{ proposalIds: string[] }> {
  // Unmatched credit transactions.
  const txns = await tx.query(
    `SELECT id, amount_cents::text AS "amountCents", reference, end_to_end_id AS "endToEndId", counterparty
     FROM bank_transactions
     WHERE client_company_id = $1 AND status = 'unmatched' AND side = 'credit'`,
    [ctx.clientCompanyId],
  );

  const proposalIds: string[] = [];
  for (const t of txns.rows) {
    // Candidate open receivables: a debit on the receivables account of the same amount.
    // MVP limitation: amount-only matching does not exclude receivables already referenced
    // by a pending/approved bank_match proposal. Two equal-amount credit transactions can
    // both propose against the same receivable. This is an accepted MVP trade-off; reference
    // matching, fuzzy matching, and candidate deduplication are future refinements.
    const cand = await tx.query(
      `SELECT je.id AS "entryId"
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.entry_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE jl.client_company_id = $1 AND a.code = $2
         AND (ROUND(jl.debit * 100))::bigint = $3::bigint
       ORDER BY je.entry_date
       LIMIT 1`,
      [ctx.clientCompanyId, config.receivablesAccount, t.amountCents],
    );
    if (!cand.rowCount) continue;
    const entryId = cand.rows[0].entryId as string;
    const confidence = t.reference || t.endToEndId ? 1.0 : 0.7;

    const rationale = {
      ruleRef: 'bank-match-amount',
      computation: `bank credit ${t.amountCents} cents matches receivable entry ${entryId}`,
      sourceRefs: { bankTransactionId: t.id, candidateEntryId: entryId, confidence, counterparty: t.counterparty },
    } as Rationale;

    const { id } = await createProposal(tx, ctx, {
      type: 'bank_match',
      payload: { bankTransactionId: t.id, candidateEntryId: entryId, amountCents: t.amountCents, bankAccount: config.bankAccount, receivablesAccount: config.receivablesAccount },
      rationale,
      status: 'pending_approval',
    });
    await tx.query(`UPDATE bank_transactions SET status = 'matched' WHERE id = $1 AND client_company_id = $2`, [t.id, ctx.clientCompanyId]);
    proposalIds.push(id);
  }
  return { proposalIds };
}

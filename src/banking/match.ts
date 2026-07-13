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

    const amountEur = (Number(t.amountCents) / 100).toFixed(2);
    const rationale = {
      ruleRef: 'bank-match-amount',
      computation: `Bank credit of ${amountEur} EUR matches an open receivable${t.counterparty ? ` from ${t.counterparty}` : ''}.`,
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

export interface ApMatchConfig { payablesAccount: string; bankAccount: string; bankClearingAccount: string; }

/**
 * Propose settlements for unmatched debit transactions. Priority: a PAY RUN whose
 * uncleared pay-run payments SUM to the debit amount (clear the transit account for
 * the whole run — a pain.001 batch is booked by the bank as one lump debit), else an
 * open bill whose outstanding equals the amount (settle directly).
 *
 * Dedup: a bank debit may only claim a given pay run / bill once. We guard both
 * within a single import run (claimed Sets) and across runs (NOT EXISTS against
 * unresolved bank_match proposals) so two equal-amount debits never double-claim the
 * same run or bill. The final post-time guard lives in postApprovedBankMatch.
 * MVP limitation: amount-only matching (no reference/fuzzy matching yet).
 */
export async function proposeApMatches(
  tx: PoolClient, ctx: TenantContext, config: ApMatchConfig,
): Promise<{ proposalIds: string[] }> {
  const txns = await tx.query(
    `SELECT id, amount_cents::text AS "amountCents", reference, counterparty
     FROM bank_transactions
     WHERE client_company_id = $1 AND status = 'unmatched' AND side = 'debit'
     ORDER BY booking_date, id`,
    [ctx.clientCompanyId],
  );

  const proposalIds: string[] = [];
  const claimedPayRunIds = new Set<string>();
  const claimedBillIds = new Set<string>();
  for (const t of txns.rows) {
    const amountEur = (Number(t.amountCents) / 100).toFixed(2);

    // (a) A pay run whose uncleared pay-run payments SUM to the debit amount → clear transit.
    // Exclude runs already claimed earlier in this import (Set) or by an unresolved proposal (NOT EXISTS).
    const run = await tx.query(
      `SELECT bp.pay_run_id AS "payRunId"
       FROM bill_payments bp
       WHERE bp.client_company_id = $1 AND bp.method = 'pay_run'
         AND bp.cleared_at IS NULL AND bp.pay_run_id IS NOT NULL
         AND ($3::uuid[] IS NULL OR bp.pay_run_id <> ALL($3::uuid[]))
         AND NOT EXISTS (
           SELECT 1 FROM proposals p
           WHERE p.client_company_id = $1 AND p.type = 'bank_match'
             AND p.status IN ('pending_approval','approved')
             AND p.payload->>'payRunId' = bp.pay_run_id::text
         )
       GROUP BY bp.pay_run_id
       HAVING SUM(bp.amount_cents) = $2::bigint
       LIMIT 1`,
      [ctx.clientCompanyId, t.amountCents, claimedPayRunIds.size ? [...claimedPayRunIds] : null],
    );
    if (run.rowCount) {
      const payRunId = run.rows[0].payRunId as string;
      const { id } = await createProposal(tx, ctx, {
        type: 'bank_match',
        payload: { kind: 'payable_clearing', bankTransactionId: t.id, payRunId, amountCents: t.amountCents, bankAccount: config.bankAccount, bankClearingAccount: config.bankClearingAccount },
        rationale: { ruleRef: 'ap-clearing', computation: `Bank debit of ${amountEur} EUR clears pay run ${payRunId}.`, sourceRefs: { bankTransactionId: t.id, payRunId } } as Rationale,
        status: 'pending_approval',
      });
      await tx.query(`UPDATE bank_transactions SET status = 'matched' WHERE id = $1 AND client_company_id = $2`, [t.id, ctx.clientCompanyId]);
      claimedPayRunIds.add(payRunId);
      proposalIds.push(id);
      continue;
    }

    // (b) Open/partially-paid bill whose outstanding equals the amount → settle directly.
    // Exclude bills already claimed earlier in this import (Set) or by an unresolved proposal (NOT EXISTS).
    const bill = await tx.query(
      `SELECT b.id, b.bill_number AS "billNumber" FROM bills b
       WHERE b.client_company_id = $1 AND b.status IN ('open','partially_paid')
         AND (b.grand_total_cents - b.amount_paid_cents) = $2::bigint
         AND ($3::uuid[] IS NULL OR b.id <> ALL($3::uuid[]))
         AND NOT EXISTS (
           SELECT 1 FROM proposals p
           WHERE p.client_company_id = $1 AND p.type = 'bank_match'
             AND p.status IN ('pending_approval','approved')
             AND p.payload->>'billId' = b.id::text
         )
       ORDER BY b.due_date LIMIT 1`,
      [ctx.clientCompanyId, t.amountCents, claimedBillIds.size ? [...claimedBillIds] : null],
    );
    if (!bill.rowCount) continue;
    const billId = bill.rows[0].id as string;
    const { id } = await createProposal(tx, ctx, {
      type: 'bank_match',
      payload: { kind: 'payable_direct', bankTransactionId: t.id, billId, amountCents: t.amountCents, bankAccount: config.bankAccount, payablesAccount: config.payablesAccount },
      rationale: { ruleRef: 'ap-direct', computation: `Bank debit of ${amountEur} EUR settles bill ${bill.rows[0].billNumber}.`, sourceRefs: { bankTransactionId: t.id, billId } } as Rationale,
      status: 'pending_approval',
    });
    await tx.query(`UPDATE bank_transactions SET status = 'matched' WHERE id = $1 AND client_company_id = $2`, [t.id, ctx.clientCompanyId]);
    claimedBillIds.add(billId);
    proposalIds.push(id);
  }
  return { proposalIds };
}

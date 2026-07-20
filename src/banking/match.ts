import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';

export interface ArMatchConfig { receivableAccount: string; bankAccount: string; }

/**
 * Propose settlements for unmatched CREDIT transactions against open receivables.
 * Match an open/partially-paid outbound invoice whose OUTSTANDING equals the credit amount
 * → settle directly on approval (postApprovedBankMatch 'receivable_direct' branch).
 *
 * Dedup mirrors proposeApMatches: a bank credit may claim a given receivable at most once,
 * guarded within one import (claimed Set) and across imports (NOT EXISTS against unresolved
 * bank_match proposals referencing the same einvoiceId). Amount-only matching is an accepted
 * MVP limitation (no reference/fuzzy matching yet).
 */
export async function proposeArMatches(
  tx: PoolClient, ctx: TenantContext, config: ArMatchConfig,
): Promise<{ proposalIds: string[] }> {
  const txns = await tx.query(
    `SELECT id, amount_cents::text AS "amountCents", reference, counterparty
     FROM bank_transactions
     WHERE client_company_id = $1 AND status = 'unmatched' AND side = 'credit'
     ORDER BY booking_date, id`,
    [ctx.clientCompanyId],
  );

  const proposalIds: string[] = [];
  const claimedIds = new Set<string>();
  for (const t of txns.rows) {
    const amountEur = (Number(t.amountCents) / 100).toFixed(2);
    const inv = await tx.query(
      `SELECT e.id, e.invoice_number AS "invoiceNumber" FROM einvoices e
       WHERE e.client_company_id = $1 AND e.direction = 'outbound'
         AND e.status IN ('open','partially_paid')
         AND (e.grand_total_cents - e.amount_paid_cents) = $2::bigint
         AND ($3::uuid[] IS NULL OR e.id <> ALL($3::uuid[]))
         AND NOT EXISTS (
           SELECT 1 FROM proposals p
           WHERE p.client_company_id = $1 AND p.type = 'bank_match'
             AND p.status IN ('pending_approval','approved')
             AND p.payload->>'einvoiceId' = e.id::text
         )
       ORDER BY e.due_date NULLS LAST LIMIT 1`,
      [ctx.clientCompanyId, t.amountCents, claimedIds.size ? [...claimedIds] : null],
    );
    if (!inv.rowCount) continue;
    const einvoiceId = inv.rows[0].id as string;
    const { id } = await createProposal(tx, ctx, {
      type: 'bank_match',
      payload: { kind: 'receivable_direct', bankTransactionId: t.id, einvoiceId, amountCents: t.amountCents, bankAccount: config.bankAccount, receivableAccount: config.receivableAccount },
      rationale: { ruleRef: 'ar-direct', computation: `Bank credit of ${amountEur} EUR settles invoice ${inv.rows[0].invoiceNumber}${t.counterparty ? ` from ${t.counterparty}` : ''}.`, sourceRefs: { bankTransactionId: t.id, einvoiceId } } as Rationale,
      status: 'pending_approval',
    });
    await tx.query(`UPDATE bank_transactions SET status = 'matched' WHERE id = $1 AND client_company_id = $2`, [t.id, ctx.clientCompanyId]);
    claimedIds.add(einvoiceId);
    proposalIds.push(id);
  }
  return { proposalIds };
}

export interface ExpenseMatchConfig { bankAccount: string; settlementAccount: string; }

/**
 * Propose reimbursements for unmatched DEBIT bank transactions that exactly equal one
 * APPROVED (not yet reimbursed) claim's gross total. Mirrors proposeApMatches' bill
 * branch: dedup guarded within one import (claimed Set) and across imports (NOT EXISTS
 * against unresolved bank_match proposals referencing the same claimId). Amount-only
 * matching is an accepted MVP limitation (no reference/fuzzy matching yet).
 */
export async function proposeExpenseMatches(
  tx: PoolClient, ctx: TenantContext, config: ExpenseMatchConfig,
): Promise<{ proposalIds: string[] }> {
  const txns = await tx.query(
    `SELECT id, amount_cents::text AS "amountCents", reference, counterparty
     FROM bank_transactions
     WHERE client_company_id = $1 AND status = 'unmatched' AND side = 'debit'
     ORDER BY booking_date, id`,
    [ctx.clientCompanyId],
  );

  const proposalIds: string[] = [];
  const claimedIds = new Set<string>();
  for (const t of txns.rows) {
    const amountEur = (Number(t.amountCents) / 100).toFixed(2);
    const claim = await tx.query(
      `SELECT c.id, c.description FROM expense_claims c
       WHERE c.client_company_id = $1 AND c.status = 'approved'
         AND c.total_cents = $2::bigint
         AND ($3::uuid[] IS NULL OR c.id <> ALL($3::uuid[]))
         AND NOT EXISTS (
           SELECT 1 FROM proposals p
           WHERE p.client_company_id = $1 AND p.type = 'bank_match'
             AND p.status IN ('pending_approval','approved')
             AND p.payload->>'claimId' = c.id::text
         )
       ORDER BY c.created_at LIMIT 1`,
      [ctx.clientCompanyId, t.amountCents, claimedIds.size ? [...claimedIds] : null],
    );
    if (!claim.rowCount) continue;
    const claimId = claim.rows[0].id as string;
    const { id } = await createProposal(tx, ctx, {
      type: 'bank_match',
      payload: { kind: 'expense_direct', bankTransactionId: t.id, claimId, amountCents: t.amountCents, bankAccount: config.bankAccount, settlementAccount: config.settlementAccount },
      rationale: { ruleRef: 'expense-direct', computation: `Bank debit of ${amountEur} EUR reimburses claim ${claim.rows[0].description}.`, sourceRefs: { bankTransactionId: t.id, claimId } } as Rationale,
      status: 'pending_approval',
    });
    await tx.query(`UPDATE bank_transactions SET status = 'matched' WHERE id = $1 AND client_company_id = $2`, [t.id, ctx.clientCompanyId]);
    claimedIds.add(claimId);
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

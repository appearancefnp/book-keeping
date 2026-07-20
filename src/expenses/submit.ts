import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getClaim, type ClaimDetail } from './claims.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';
import type { NewJournalEntry } from '../ledger/posting.js';
import { fromCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export interface ClaimAccounts { settlementAccount: string; vatInputAccount: string; }

/**
 * DR each line's expense account — the net amount if the line is VAT-deductible, otherwise the
 * GROSS amount (net+vat), since non-deductible VAT is just part of the expense. Mileage lines
 * carry vat=0 so the same formula reduces to their net. DR VAT-input for the sum of deductible
 * VAT (if any). CR the settlement account for the claim's gross total. Mirrors buildBillEntry's
 * shape (src/payables/bills.ts).
 */
export function buildClaimEntry(detail: ClaimDetail, accounts: ClaimAccounts): NewJournalEntry {
  const deductibleVat = detail.lines
    .filter((l) => l.vatDeductible)
    .reduce((a, l) => a + BigInt(l.vatCents), 0n);
  const lines = detail.lines.map((l) => {
    const debitCents = l.vatDeductible ? BigInt(l.netCents) : BigInt(l.netCents) + BigInt(l.vatCents);
    return { accountCode: l.expenseAccount, debit: fromCents(debitCents), credit: '0', description: l.description };
  });
  if (deductibleVat > 0n) {
    lines.push({ accountCode: accounts.vatInputAccount, debit: fromCents(deductibleVat), credit: '0', description: 'VAT input' });
  }
  lines.push({
    accountCode: accounts.settlementAccount, debit: '0', credit: fromCents(BigInt(detail.totalCents)),
    description: 'Employee settlement',
  });
  return {
    date: detail.createdAt.slice(0, 10),
    memo: `Expense claim — ${detail.employeeName}`,
    currency: detail.currency,
    lines,
  };
}

/** Submit a draft claim for approval: creates a pending posting proposal and flips status. */
export async function submitClaim(
  tx: PoolClient, ctx: TenantContext, claimId: string, accounts: ClaimAccounts,
): Promise<{ proposalId: string }> {
  // getClaim already enforces self-scope for client-side roles (throws Forbidden otherwise).
  const detail = await getClaim(tx, ctx, claimId);
  if (detail.status !== 'draft') throw new Error(`Only draft claims can be submitted (status=${detail.status})`);
  if (detail.lines.length === 0) throw new Error('Cannot submit an empty claim');
  if (BigInt(detail.totalCents) <= 0n) throw new Error('Cannot submit a zero-total claim');

  const rationale = {
    ruleRef: 'expense-claim',
    computation: `${detail.employeeName}: total ${fromCents(BigInt(detail.totalCents))}`,
    sourceRefs: { claimId, employeeId: detail.employeeId },
  } as Rationale;
  const { id: proposalId } = await createProposal(tx, ctx, {
    type: 'posting', payload: buildClaimEntry(detail, accounts), rationale,
    documentId: null, status: 'pending_approval',
  });

  await tx.query(
    `UPDATE expense_claims SET status = 'submitted', posting_proposal_id = $1 WHERE id = $2 AND client_company_id = $3`,
    [proposalId, claimId, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: 'submit', entityType: 'expense_claim', entityId: claimId,
    before: { status: 'draft' }, after: { status: 'submitted', proposalId },
  });
  return { proposalId };
}

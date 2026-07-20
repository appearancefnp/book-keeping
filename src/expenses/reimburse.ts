import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getClaim } from './claims.js';
import { postEntry } from '../ledger/posting.js';
import { generateSepaCreditTransfer } from '../banking/sepa.js';
import { fromCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export interface SettleClaimArgs {
  claimId: string;
  paidDate: string;
  method: 'manual' | 'bank_match';
  bankTransactionId?: string | null;
  bankAccount: string;
  settlementAccount: string;
}

/**
 * Pay out an approved claim: DR settlementAccount (clears the liability booked at approval) /
 * CR bankAccount, for the claim's gross total. Mirrors settleReceivable's structure/guards.
 */
export async function settleClaim(
  tx: PoolClient, ctx: TenantContext, args: SettleClaimArgs,
): Promise<{ entryId: string }> {
  const claim = await getClaim(tx, ctx, args.claimId);
  if (claim.status !== 'approved') {
    throw new Error(`Claim ${args.claimId} is not settleable (status=${claim.status})`);
  }

  // Dedup: a given bank transaction may settle at most one claim (unique index backstops races).
  if (args.bankTransactionId) {
    const dup = await tx.query(
      `SELECT 1 FROM expense_claims WHERE client_company_id = $1 AND reimbursement_bank_transaction_id = $2 LIMIT 1`,
      [ctx.clientCompanyId, args.bankTransactionId],
    );
    if (dup.rowCount) throw new Error(`Claim already settled by bank transaction ${args.bankTransactionId}`);
  }

  const dec = fromCents(BigInt(claim.totalCents));
  const { entryId } = await postEntry(tx, ctx, {
    date: args.paidDate,
    memo: `Expense reimbursement — ${claim.employeeName}`,
    currency: claim.currency,
    lines: [
      { accountCode: args.settlementAccount, debit: dec, credit: '0', description: 'Clear employee settlement' },
      { accountCode: args.bankAccount, debit: '0', credit: dec, description: 'Bank payment' },
    ],
  });

  await tx.query(
    `UPDATE expense_claims
     SET reimbursement_entry_id = $1, reimbursement_bank_transaction_id = $2, reimbursed_at = now(), status = 'reimbursed'
     WHERE id = $3 AND client_company_id = $4`,
    [entryId, args.bankTransactionId ?? null, args.claimId, ctx.clientCompanyId],
  );

  await appendAudit(tx, ctx, {
    action: 'settle', entityType: 'expense_claim', entityId: args.claimId,
    before: { status: claim.status },
    after: { status: 'reimbursed', entryId, method: args.method, bankTransactionId: args.bankTransactionId ?? null },
  });

  return { entryId };
}

interface ClaimPayeeRow {
  id: string; description: string; totalCents: string;
  firstName: string; lastName: string; iban: string | null;
}

/**
 * Build a pain.001 SEPA credit-transfer batch for the given approved claims, one payment per
 * claim to the employee's IBAN. Throws (naming the employees) if any lacks an IBAN.
 * Generates a payment order but records no "reimbursement initiated" state, so this can be
 * called more than once for the same claims; a double-pay is caught downstream because
 * expense_direct bank-matching dedups per bank transaction, so only one debit can settle a
 * given claim. (When real bank sends land, add an order-generated marker.)
 */
export async function buildReimbursementOrder(
  tx: PoolClient, ctx: TenantContext, claimIds: string[],
): Promise<{ xml: string; total: string }> {
  const res = await tx.query(
    `SELECT c.id, c.description, c.total_cents AS "totalCents",
            e.first_name AS "firstName", e.last_name AS "lastName", e.iban AS "iban"
     FROM expense_claims c JOIN employees e ON e.id = c.employee_id
     WHERE c.client_company_id = $1 AND c.id = ANY($2::uuid[]) AND c.status = 'approved'`,
    [ctx.clientCompanyId, claimIds],
  );
  const rows = res.rows as ClaimPayeeRow[];
  // NOTE: duplicate claimIds in the input undercount here (ANY() dedups matches against
  // distinct rows), which can produce a confusing empty missing-list error below; dedupe
  // the input or count distinct occurrences if this path gets hardened.
  if (rows.length !== claimIds.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = claimIds.filter((id) => !found.has(id));
    throw new Error(`Claim(s) not found or not approved: ${missing.join(', ')}`);
  }

  const missingIban = rows.filter((r) => !r.iban);
  if (missingIban.length) {
    const names = missingIban.map((r) => `${r.firstName} ${r.lastName}`).join(', ');
    throw new Error(`Cannot build reimbursement order: missing IBAN for ${names}`);
  }

  const totalCents = rows.reduce((a, r) => a + BigInt(r.totalCents), 0n);
  const payments = rows.map((r) => ({
    iban: r.iban!,
    amount: fromCents(BigInt(r.totalCents)),
    reference: `Expense claim ${r.id.slice(0, 8)} — ${r.description}`,
  }));

  const xml = generateSepaCreditTransfer(payments);
  return { xml, total: fromCents(totalCents) };
}

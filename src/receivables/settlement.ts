import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getReceivable } from './receivables.js';
import { postEntry } from '../ledger/posting.js';
import { fromCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export interface SettleReceivableArgs {
  einvoiceId: string;
  amountCents: string;
  paidDate: string;
  method: 'bank_match' | 'manual';
  bankTransactionId?: string | null;
  bankAccount: string;
  receivableAccount: string;
}

/** Post DR bankAccount / CR receivableAccount for amountCents, record the payment, advance receivable status. */
export async function settleReceivable(
  tx: PoolClient, ctx: TenantContext, args: SettleReceivableArgs,
): Promise<{ entryId: string; invoicePaymentId: string }> {
  const r = await getReceivable(tx, ctx, args.einvoiceId);
  if (r.status !== 'open' && r.status !== 'partially_paid') {
    throw new Error(`Receivable ${r.invoiceNumber} is not settleable (status=${r.status})`);
  }
  const amount = BigInt(args.amountCents);
  const outstanding = BigInt(r.outstandingCents);
  if (amount <= 0n) throw new Error(`Settlement amount must be positive (got ${args.amountCents})`);
  if (amount > outstanding) throw new Error(`Settlement ${args.amountCents} exceeds outstanding ${r.outstandingCents}`);

  // Dedup: a given bank transaction may settle a receivable at most once.
  if (args.bankTransactionId) {
    const dup = await tx.query(
      `SELECT 1 FROM invoice_payments WHERE client_company_id = $1 AND bank_transaction_id = $2 LIMIT 1`,
      [ctx.clientCompanyId, args.bankTransactionId],
    );
    if (dup.rowCount) throw new Error(`Receivable already settled by bank transaction ${args.bankTransactionId}`);
  }

  const dec = fromCents(amount);
  const { entryId } = await postEntry(tx, ctx, {
    date: args.paidDate, memo: `Invoice payment ${r.invoiceNumber}`, currency: r.currency,
    lines: [
      { accountCode: args.bankAccount, debit: dec, credit: '0', description: 'Bank receipt' },
      { accountCode: args.receivableAccount, debit: '0', credit: dec, description: 'Settle receivable' },
    ],
  });

  const pay = await tx.query(
    `INSERT INTO invoice_payments(client_company_id, einvoice_id, amount_cents, paid_date, method, bank_transaction_id, journal_entry_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [ctx.clientCompanyId, args.einvoiceId, amount.toString(), args.paidDate, args.method, args.bankTransactionId ?? null, entryId],
  );
  const invoicePaymentId = pay.rows[0].id as string;

  const newPaid = BigInt(r.amountPaidCents) + amount;
  const status = newPaid >= BigInt(r.grandTotalCents) ? 'paid' : 'partially_paid';
  await tx.query(
    `UPDATE einvoices SET amount_paid_cents = $1, status = $2 WHERE id = $3 AND client_company_id = $4`,
    [newPaid.toString(), status, args.einvoiceId, ctx.clientCompanyId],
  );

  await appendAudit(tx, ctx, {
    action: 'settle', entityType: 'receivable', entityId: args.einvoiceId,
    before: { amountPaidCents: r.amountPaidCents, status: r.status },
    after: { amountPaidCents: newPaid.toString(), status, method: args.method, entryId },
  });
  return { entryId, invoicePaymentId };
}

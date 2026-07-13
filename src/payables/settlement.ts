import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { getBill } from './bills.js';
import { postEntry } from '../ledger/posting.js';
import { fromCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export interface SettleArgs {
  billId: string;
  amountCents: string;
  paidDate: string;
  method: 'pay_run' | 'bank_match' | 'manual';
  payablesAccount: string;
  creditAccount: string;
  payRunId?: string | null;
  bankTransactionId?: string | null;
}

/** Post DR payables / CR creditAccount for amountCents, record the payment, advance bill status. */
export async function settleBill(
  tx: PoolClient, ctx: TenantContext, args: SettleArgs,
): Promise<{ entryId: string; billPaymentId: string }> {
  const bill = await getBill(tx, ctx, args.billId);
  const amount = BigInt(args.amountCents);
  const outstanding = BigInt(bill.outstandingCents);
  if (amount <= 0n) throw new Error(`Settlement amount must be positive (got ${args.amountCents})`);
  if (amount > outstanding) throw new Error(`Settlement ${args.amountCents} exceeds outstanding ${bill.outstandingCents}`);

  const dec = fromCents(amount);
  const { entryId } = await postEntry(tx, ctx, {
    date: args.paidDate, memo: `Bill payment ${bill.billNumber}`, currency: bill.currency,
    lines: [
      { accountCode: args.payablesAccount, debit: dec, credit: '0', description: 'Settle payable' },
      { accountCode: args.creditAccount, debit: '0', credit: dec, description: 'Payment' },
    ],
  });

  const pay = await tx.query(
    `INSERT INTO bill_payments(client_company_id, bill_id, amount_cents, paid_date, method, pay_run_id, bank_transaction_id, journal_entry_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [ctx.clientCompanyId, args.billId, amount.toString(), args.paidDate, args.method, args.payRunId ?? null, args.bankTransactionId ?? null, entryId],
  );
  const billPaymentId = pay.rows[0].id as string;

  const newPaid = BigInt(bill.amountPaidCents) + amount;
  const status = newPaid >= BigInt(bill.grandTotalCents) ? 'paid' : 'partially_paid';
  await tx.query(
    `UPDATE bills SET amount_paid_cents = $1, status = $2 WHERE id = $3 AND client_company_id = $4`,
    [newPaid.toString(), status, args.billId, ctx.clientCompanyId],
  );

  await appendAudit(tx, ctx, {
    action: 'settle', entityType: 'bill', entityId: args.billId,
    before: { amountPaidCents: bill.amountPaidCents, status: bill.status },
    after: { amountPaidCents: newPaid.toString(), status, method: args.method, entryId },
  });
  return { entryId, billPaymentId };
}

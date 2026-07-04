import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export type BankTxnStatus = 'unmatched' | 'matched' | 'reconciled';

export interface BankTransactionRow {
  id: string;
  account: string;
  bookingDate: string;
  amountCents: string;
  currency: string;
  side: 'credit' | 'debit';
  reference: string;
  counterparty: string;
  status: BankTxnStatus;
  matchedEntryId: string | null;
}

export async function listBankTransactions(
  tx: PoolClient,
  ctx: TenantContext,
  filter: { status?: BankTxnStatus; limit?: number } = {},
): Promise<BankTransactionRow[]> {
  const params: unknown[] = [ctx.clientCompanyId];
  let where = 'client_company_id = $1';
  if (filter.status) {
    params.push(filter.status);
    where += ` AND status = $${params.length}`;
  }
  params.push(filter.limit ?? 100);
  const res = await tx.query(
    `SELECT id, account, to_char(booking_date, 'YYYY-MM-DD') AS booking_date,
            amount_cents::text AS amount_cents, currency, side, reference,
            counterparty, status, matched_entry_id
       FROM bank_transactions
      WHERE ${where}
      ORDER BY booking_date DESC, created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return res.rows.map((r) => ({
    id: r.id,
    account: r.account,
    bookingDate: r.booking_date,
    amountCents: r.amount_cents,
    currency: r.currency,
    side: r.side,
    reference: r.reference,
    counterparty: r.counterparty,
    status: r.status,
    matchedEntryId: r.matched_entry_id,
  }));
}

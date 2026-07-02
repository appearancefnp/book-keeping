import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { BankStatement } from './camt-parser.js';
import { appendAudit } from '../audit/audit.js';

export async function importStatement(
  tx: PoolClient, ctx: TenantContext, stmt: BankStatement,
): Promise<{ imported: number; skipped: number }> {
  let imported = 0; let skipped = 0;
  for (const t of stmt.transactions) {
    const res = await tx.query(
      `INSERT INTO bank_transactions
         (client_company_id, account, booking_date, amount_cents, currency, side, reference, counterparty, end_to_end_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (client_company_id, account, end_to_end_id, amount_cents, booking_date) DO NOTHING
       RETURNING id`,
      [ctx.clientCompanyId, stmt.account, t.bookingDate, t.amountCents, t.currency, t.side, t.reference, t.counterparty, t.endToEndId],
    );
    if (res.rowCount) imported++; else skipped++;
  }
  await appendAudit(tx, ctx, { action: 'import', entityType: 'bank_statement', entityId: null, before: null, after: { account: stmt.account, imported, skipped } });
  return { imported, skipped };
}

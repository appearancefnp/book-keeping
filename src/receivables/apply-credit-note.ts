import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

/**
 * Apply an issued AR credit note against the invoice it corrects (EN 16931
 * BillingReference). Settlement-like: caps at the invoice outstanding, records an
 * invoice_payments row (method 'credit_note'), advances amount_paid/status. No GL
 * posting — sendCreditNote already posted the receivable reversal (journalEntryId).
 * Unresolvable reference, currency mismatch, or non-open invoice → applies nothing.
 */
export async function applyCreditNoteToInvoice(
  tx: PoolClient, ctx: TenantContext,
  args: {
    creditNoteEinvoiceId: string; correctedInvoiceNumber: string;
    creditNoteGrandCents: bigint; currency: string; issueDate: string; journalEntryId: string;
  },
): Promise<{ appliedCents: bigint; invoiceId: string | null }> {
  const inv = await tx.query(
    `SELECT id, grand_total_cents, amount_paid_cents, invoice_number
     FROM einvoices
     WHERE client_company_id = $1 AND direction = 'outbound' AND doc_type = 'invoice'
       AND invoice_number = $2 AND currency = $3 AND status IN ('open','partially_paid')
     ORDER BY created_at DESC LIMIT 1`,
    [ctx.clientCompanyId, args.correctedInvoiceNumber, args.currency],
  );
  if (!inv.rowCount) return { appliedCents: 0n, invoiceId: null };
  const row = inv.rows[0];
  const outstanding = BigInt(row.grand_total_cents) - BigInt(row.amount_paid_cents);
  const applied = args.creditNoteGrandCents < outstanding ? args.creditNoteGrandCents : outstanding;
  if (applied <= 0n) return { appliedCents: 0n, invoiceId: null };

  await tx.query(
    `INSERT INTO invoice_payments(client_company_id, einvoice_id, amount_cents, paid_date, method, journal_entry_id, credit_note_einvoice_id)
     VALUES ($1,$2,$3,$4,'credit_note',$5,$6)`,
    [ctx.clientCompanyId, row.id, applied.toString(), args.issueDate, args.journalEntryId, args.creditNoteEinvoiceId],
  );
  const newPaid = BigInt(row.amount_paid_cents) + applied;
  const status = newPaid >= BigInt(row.grand_total_cents) ? 'paid' : 'partially_paid';
  await tx.query(
    `UPDATE einvoices SET amount_paid_cents = $1, status = $2 WHERE id = $3 AND client_company_id = $4`,
    [newPaid.toString(), status, row.id, ctx.clientCompanyId],
  );
  await appendAudit(tx, ctx, {
    action: 'apply_credit_note', entityType: 'receivable', entityId: row.id,
    before: { amountPaidCents: row.amount_paid_cents },
    after: { amountPaidCents: newPaid.toString(), status, creditNoteEinvoiceId: args.creditNoteEinvoiceId, appliedCents: applied.toString() },
  });
  return { appliedCents: applied, invoiceId: row.id };
}

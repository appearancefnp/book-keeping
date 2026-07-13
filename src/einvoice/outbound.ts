import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccessPoint } from './access-point.js';
import { buildUblInvoice, type EInvoice } from './ubl.js';
import { validateEn16931 } from './validate.js';
import { postEntry } from '../ledger/posting.js';
import { toCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';

export async function sendInvoice(
  tx: PoolClient, ctx: TenantContext,
  args: { invoice: EInvoice; recipientPeppolId: string; ap: AccessPoint; receivableAccount: string; salesAccount: string; vatAccount: string; customerPartyId?: string | null; dueDate?: string | null },
): Promise<{ einvoiceId: string; entryId: string; messageId: string }> {
  const inv = args.invoice;

  // 1. Validate against EN 16931 BEFORE anything else.
  const v = validateEn16931(inv);
  if (!v.valid) throw new Error(`EN16931 validation failed: ${v.issues.join('; ')}`);

  // 2. Render UBL.
  const ubl = buildUblInvoice(inv);

  // 3. Post the receivable: DR receivable (gross) / CR sales (net) / CR VAT (vat).
  const { entryId } = await postEntry(tx, ctx, {
    date: inv.issueDate, memo: `Sales invoice ${inv.invoiceNumber}`, currency: inv.currency,
    lines: [
      { accountCode: args.receivableAccount, debit: inv.grandTotal, credit: '0', description: 'Receivable' },
      { accountCode: args.salesAccount, debit: '0', credit: inv.netTotal, description: 'Sales' },
      { accountCode: args.vatAccount, debit: '0', credit: inv.vatTotal, description: 'Output VAT' },
    ],
  });

  // 4. Dispatch via the Access Point.
  // NOTE: ap.send is a network side effect outside the DB transaction; if send succeeds but
  // the subsequent einvoice INSERT fails, the invoice is dispatched-but-unrecorded. This is an
  // accepted MVP limitation; a future outbox/idempotency-key pattern should close the window.
  const { messageId } = await args.ap.send(ubl, args.recipientPeppolId);

  // 5. Record the einvoice (vid_status pending — VID submission handled in Task 6).
  const res = await tx.query(
    `INSERT INTO einvoices(client_company_id, direction, invoice_number, issue_date, grand_total_cents, currency, ubl_xml, vid_status, peppol_status, peppol_message_id, journal_entry_id, customer_party_id, due_date, status)
     VALUES ($1,'outbound',$2,$3,$4,$5,$6,'pending','sent',$7,$8,$9,$10,'open') RETURNING id`,
    [ctx.clientCompanyId, inv.invoiceNumber, inv.issueDate, toCents(inv.grandTotal).toString(), inv.currency, ubl, messageId, entryId, args.customerPartyId ?? null, args.dueDate ?? inv.dueDate ?? null],
  );
  const einvoiceId = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'send', entityType: 'einvoice', entityId: einvoiceId, before: null, after: { invoiceNumber: inv.invoiceNumber, messageId, entryId } });
  return { einvoiceId, entryId, messageId };
}

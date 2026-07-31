import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccessPoint } from './access-point.js';
import { buildUblInvoice, buildUblCreditNote, type EInvoice, type ECreditNote } from './ubl.js';
import { validateEn16931 } from './validate.js';
import { postEntry } from '../ledger/posting.js';
import { toCents } from '../db/money.js';
import { appendAudit } from '../audit/audit.js';
import { applyCreditNoteToInvoice } from '../receivables/apply-credit-note.js';
import { insertEinvoiceLines } from './lines.js';

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

  // 3. Post the receivable: DR receivable (gross) / CR sales (net) / CR VAT (vat, if > 0).
  const invVat = toCents(inv.vatTotal);
  const invLines = [
    { accountCode: args.receivableAccount, debit: inv.grandTotal, credit: '0', description: 'Receivable' },
    { accountCode: args.salesAccount, debit: '0', credit: inv.netTotal, description: 'Sales' },
  ];
  if (invVat > 0n) invLines.push({ accountCode: args.vatAccount, debit: '0', credit: inv.vatTotal, description: 'Output VAT' });
  const { entryId } = await postEntry(tx, ctx, {
    date: inv.issueDate, memo: `Sales invoice ${inv.invoiceNumber}`, currency: inv.currency,
    lines: invLines,
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
  await insertEinvoiceLines(tx, ctx, einvoiceId, inv.lines);
  await appendAudit(tx, ctx, { action: 'send', entityType: 'einvoice', entityId: einvoiceId, before: null, after: { invoiceNumber: inv.invoiceNumber, messageId, entryId } });
  return { einvoiceId, entryId, messageId };
}

export async function sendCreditNote(
  tx: PoolClient, ctx: TenantContext,
  args: { creditNote: ECreditNote; recipientPeppolId: string; ap: AccessPoint; receivableAccount: string; salesAccount: string; vatAccount: string },
): Promise<{ einvoiceId: string; entryId: string; messageId: string }> {
  const cn = args.creditNote;

  // 1. Validate against EN 16931 BEFORE anything else.
  const v = validateEn16931(cn);
  if (!v.valid) throw new Error(`EN16931 validation failed: ${v.issues.join('; ')}`);

  // 2. Render UBL.
  const ubl = buildUblCreditNote(cn);

  // 3. Reverse the sale: DR sales (net) / DR output VAT (vat, if > 0) / CR receivable (grand).
  const cnVat = toCents(cn.vatTotal);
  const cnLines = [
    { accountCode: args.salesAccount, debit: cn.netTotal, credit: '0', description: 'Sales reversal' },
  ];
  if (cnVat > 0n) cnLines.push({ accountCode: args.vatAccount, debit: cn.vatTotal, credit: '0', description: 'Output VAT reversal' });
  cnLines.push({ accountCode: args.receivableAccount, debit: '0', credit: cn.grandTotal, description: 'Receivable reduction' });
  const { entryId } = await postEntry(tx, ctx, {
    date: cn.issueDate, memo: `Credit note ${cn.invoiceNumber}`, currency: cn.currency,
    lines: cnLines,
  });

  // 4. Dispatch via the Access Point.
  // NOTE: ap.send is a network side effect outside the DB transaction; if send succeeds but
  // the subsequent einvoice INSERT fails, the credit note is dispatched-but-unrecorded. This is
  // an accepted MVP limitation; a future outbox/idempotency-key pattern should close the window.
  const { messageId } = await args.ap.send(ubl, args.recipientPeppolId);

  // 5. Record the einvoice (vid_status pending — VID submission handled in Task 6).
  const res = await tx.query(
    `INSERT INTO einvoices(client_company_id, direction, doc_type, invoice_number, corrected_invoice_number, issue_date, grand_total_cents, currency, ubl_xml, vid_status, peppol_status, peppol_message_id, journal_entry_id)
     VALUES ($1,'outbound','credit_note',$2,$3,$4,$5,$6,$7,'pending','sent',$8,$9) RETURNING id`,
    [ctx.clientCompanyId, cn.invoiceNumber, cn.correctedInvoiceNumber ?? null, cn.issueDate, toCents(cn.grandTotal).toString(), cn.currency, ubl, messageId, entryId],
  );
  const einvoiceId = res.rows[0].id as string;
  await insertEinvoiceLines(tx, ctx, einvoiceId, cn.lines);
  await appendAudit(tx, ctx, { action: 'send', entityType: 'einvoice', entityId: einvoiceId, before: null, after: { docType: 'credit_note', invoiceNumber: cn.invoiceNumber, messageId, entryId } });

  // 6. If this credit note references an open invoice, apply it like a payment so the
  // AR open-item model and dunning agree with the GL reversal just posted above.
  if (cn.correctedInvoiceNumber) {
    await applyCreditNoteToInvoice(tx, ctx, {
      creditNoteEinvoiceId: einvoiceId,
      correctedInvoiceNumber: cn.correctedInvoiceNumber,
      creditNoteGrandCents: toCents(cn.grandTotal),
      currency: cn.currency,
      issueDate: cn.issueDate,
      journalEntryId: entryId,
    });
  }

  return { einvoiceId, entryId, messageId };
}

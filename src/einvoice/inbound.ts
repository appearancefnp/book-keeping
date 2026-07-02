import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccessPoint } from './access-point.js';
import { parseUblInvoice } from './ubl.js';
import { extractedToJournalEntry, type PostingTemplate } from '../intake/map-posting.js';
import type { ExtractedInvoice } from '../intake/extraction-schema.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';
import { toCents } from '../db/money.js';

export async function receiveInboundInvoices(
  tx: PoolClient, ctx: TenantContext, args: { ap: AccessPoint; template: PostingTemplate },
): Promise<{ proposalIds: string[] }> {
  const batch = await args.ap.receive();
  const proposalIds: string[] = [];

  for (const msg of batch) {
    const ubl = parseUblInvoice(msg.ublXml);

    // Record the inbound einvoice.
    const rec = await tx.query(
      `INSERT INTO einvoices(client_company_id, direction, invoice_number, issue_date, grand_total_cents, currency, ubl_xml, peppol_status, vid_status)
       VALUES ($1,'inbound',$2,$3,$4,$5,$6,'received','not_required') RETURNING id`,
      [ctx.clientCompanyId, ubl.invoiceNumber, ubl.issueDate, toCents(ubl.grandTotal).toString(), ubl.currency, msg.ublXml],
    );
    const einvoiceId = rec.rows[0].id as string;

    // Map structured invoice -> ExtractedInvoice shape (no OCR) -> journal entry payload.
    const extracted: ExtractedInvoice = {
      supplierName: ubl.supplier.name, supplierRegNo: ubl.supplier.regNo,
      date: ubl.issueDate, currency: ubl.currency,
      lineItems: ubl.lines.map((l) => ({ description: l.description, net: l.net, vatRate: l.vatRate, vat: l.vat })),
      vatTotal: ubl.vatTotal, netTotal: ubl.netTotal, grandTotal: ubl.grandTotal,
    };
    const entry = extractedToJournalEntry(extracted, args.template);

    const rationale = {
      ruleRef: 'peppol-inbound',
      computation: `net ${ubl.netTotal} + VAT ${ubl.vatTotal} = ${ubl.grandTotal}`,
      sourceRefs: { einvoiceId, invoiceNumber: ubl.invoiceNumber, source: 'peppol' },
    } as Rationale;

    const { id } = await createProposal(tx, ctx, { type: 'posting', payload: entry, rationale, status: 'pending_approval' });
    proposalIds.push(id);
  }

  return { proposalIds };
}

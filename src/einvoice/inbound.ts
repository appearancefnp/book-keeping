import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccessPoint } from './access-point.js';
import { parseUblInvoice } from './ubl.js';
import type { PostingTemplate } from '../intake/map-posting.js';
import { createBill, type BillAccounts } from '../payables/bills.js';
import { listParties, createParty } from '../parties/parties.js';
import { toCents, fromCents } from '../db/money.js';

/** Add whole days to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC-safe). */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// UBL invoice lines carry a VAT *rate* (Percent) but not a per-line VAT amount, so
// parseUblInvoice cannot fill it in (it always reports '0'). Derive it from net × rate
// rather than trusting that field, or every Peppol bill would post with zero VAT.
function computeLineVat(net: string, vatRate: number): string {
  const vatCents = BigInt(Math.round(Number(toCents(net)) * vatRate / 100));
  return fromCents(vatCents);
}

export async function receiveInboundInvoices(
  tx: PoolClient, ctx: TenantContext,
  args: { ap: AccessPoint; template: PostingTemplate; accounts: BillAccounts; dueDays?: number },
): Promise<{ billIds: string[]; proposalIds: string[] }> {
  const batch = await args.ap.receive();
  const billIds: string[] = [];
  const proposalIds: string[] = [];

  for (const msg of batch) {
    const ubl = parseUblInvoice(msg.ublXml);

    const rec = await tx.query(
      `INSERT INTO einvoices(client_company_id, direction, invoice_number, issue_date, grand_total_cents, currency, ubl_xml, peppol_status, vid_status)
       VALUES ($1,'inbound',$2,$3,$4,$5,$6,'received','not_required') RETURNING id`,
      [ctx.clientCompanyId, ubl.invoiceNumber, ubl.issueDate, toCents(ubl.grandTotal).toString(), ubl.currency, msg.ublXml],
    );
    const einvoiceId = rec.rows[0].id as string;

    // The customer has no per-line expense mapping from the vendor's UBL, so all
    // lines post to the template's single expense account (accountant can re-map later).
    const vendorPartyId = await resolveOrCreateVendor(tx, ctx, ubl.supplier);
    const { billId, proposalId } = await createBill(tx, ctx, {
      vendorPartyId,
      billNumber: ubl.invoiceNumber, issueDate: ubl.issueDate, dueDate: addDays(ubl.issueDate, args.dueDays ?? 30),
      currency: ubl.currency,
      lines: ubl.lines.map((l) => ({
        description: l.description, expenseAccount: args.template.expenseAccount,
        net: l.net, vatRate: l.vatRate, vat: computeLineVat(l.net, l.vatRate),
      })),
      source: 'peppol', einvoiceId,
    }, args.accounts);

    billIds.push(billId);
    proposalIds.push(proposalId);
  }
  return { billIds, proposalIds };
}

/** Find a vendor (or dual-role) party by reg-no, falling back to exact name match; create one if absent. */
async function resolveOrCreateVendor(
  tx: PoolClient, ctx: TenantContext, supplier: { name: string; regNo: string; vatNo: string },
): Promise<string> {
  const parties = await listParties(tx, ctx);
  const match = parties.find((p) => (p.kind === 'vendor' || p.kind === 'both')
    && (supplier.regNo ? p.regNo === supplier.regNo : p.name === supplier.name));
  if (match) return match.id;
  const created = await createParty(tx, ctx, {
    kind: 'vendor', name: supplier.name, regNo: supplier.regNo || null, vatNo: supplier.vatNo || null,
  });
  return created.id;
}

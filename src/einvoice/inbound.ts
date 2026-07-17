import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { AccessPoint } from './access-point.js';
import { parseUblInvoice, parseUblCreditNote, detectUblRoot } from './ubl.js';
import type { PostingTemplate } from '../intake/map-posting.js';
import { createBill, type BillAccounts } from '../payables/bills.js';
import { createVendorCreditNote } from '../payables/credit-notes.js';
import { listParties, createParty } from '../parties/parties.js';
import { toCents, fromCents, sumCents } from '../db/money.js';

/** Add whole days to a YYYY-MM-DD date, returning YYYY-MM-DD (UTC-safe). */
function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// UBL invoice lines carry a VAT *rate* (Percent) but not a per-line VAT amount, so
// parseUblInvoice cannot fill it in (it always reports '0'). Derive per-line VAT from
// net × rate (or every Peppol bill would post with zero VAT), THEN reconcile the sum
// to the vendor's declared vatTotal: per-line rounding can drift a cent or two from
// the vendor's total-level rounding, and the bill's totals (Σ net + Σ vat) must match
// the einvoice row we write from toCents(ubl.grandTotal). We absorb the whole rounding
// remainder into the last line's VAT so Σ(line vat) == toCents(ubl.vatTotal) exactly.
function reconciledLineVatCents(lines: { net: string; vatRate: number }[], vatTotal: string): bigint[] {
  const per = lines.map((l) => (toCents(l.net) * BigInt(Math.round(l.vatRate * 100)) + 5000n) / 10000n);
  if (per.length === 0) return per;
  const declared = toCents(vatTotal);
  const remainder = declared - per.reduce((a, c) => a + c, 0n);
  per[per.length - 1] = per[per.length - 1]! + remainder;
  return per;
}

export async function receiveInboundInvoices(
  tx: PoolClient, ctx: TenantContext,
  args: { ap: AccessPoint; template: PostingTemplate; accounts: BillAccounts; dueDays?: number },
): Promise<{ billIds: string[]; proposalIds: string[]; creditNoteIds: string[] }> {
  const batch = await args.ap.receive();
  const billIds: string[] = [];
  const proposalIds: string[] = [];
  const creditNoteIds: string[] = [];

  for (const msg of batch) {
    const root = detectUblRoot(msg.ublXml);

    if (root === 'CreditNote') {
      const cn = parseUblCreditNote(msg.ublXml);

      // Same reconciliation guards as the invoice path (see below), applied to the
      // vendor's declared credit note totals.
      const netTotalCents = toCents(cn.netTotal);
      const vatTotalCents = toCents(cn.vatTotal);
      const grandTotalCents = toCents(cn.grandTotal);
      if (netTotalCents + vatTotalCents !== grandTotalCents) {
        throw new Error(
          `Inbound credit note ${cn.invoiceNumber}: declared totals do not reconcile (net ${cn.netTotal} + VAT ${cn.vatTotal} ≠ grand ${cn.grandTotal}); manual review required`,
        );
      }
      const lineNetCents = sumCents(cn.lines.map((l) => l.net));
      if (lineNetCents !== netTotalCents) {
        throw new Error(
          `Inbound credit note ${cn.invoiceNumber}: line net total (${fromCents(lineNetCents)}) does not reconcile with the declared net total (${cn.netTotal}); manual review required`,
        );
      }

      const rec = await tx.query(
        `INSERT INTO einvoices(client_company_id, direction, doc_type, invoice_number, corrected_invoice_number, issue_date, grand_total_cents, currency, ubl_xml, peppol_status, vid_status)
         VALUES ($1,'inbound','credit_note',$2,$3,$4,$5,$6,$7,'received','not_required') RETURNING id`,
        [ctx.clientCompanyId, cn.invoiceNumber, cn.correctedInvoiceNumber ?? null, cn.issueDate, grandTotalCents.toString(), cn.currency, msg.ublXml],
      );
      const einvoiceId = rec.rows[0].id as string;

      const vendorPartyId = await resolveOrCreateVendor(tx, ctx, cn.supplier);
      const lineVat = reconciledLineVatCents(cn.lines, cn.vatTotal);
      const { creditNoteId, proposalId } = await createVendorCreditNote(tx, ctx, {
        vendorPartyId, creditNoteNumber: cn.invoiceNumber, issueDate: cn.issueDate, currency: cn.currency,
        correctedBillNumber: cn.correctedInvoiceNumber ?? null,
        lines: cn.lines.map((l, i) => ({
          description: l.description, expenseAccount: args.template.expenseAccount,
          net: l.net, vatRate: l.vatRate, vat: fromCents(lineVat[i]!),
        })),
        source: 'peppol', einvoiceId,
      }, args.accounts);
      creditNoteIds.push(creditNoteId);
      proposalIds.push(proposalId);
      continue;
    }

    const ubl = parseUblInvoice(msg.ublXml);

    // The vendor's own declared totals must add up before we book anything: net + VAT
    // must equal the PayableAmount (grandTotal), and the line nets must sum to the
    // declared net total. If they don't, there's a document-level rounding/charge that
    // reconciledLineVatCents cannot absorb (it only reconciles VAT, not the grand total),
    // and silently fabricating a grand total would let bills.grand_total_cents disagree
    // with einvoices.grand_total_cents (and underpay/overpay the vendor). Reject instead,
    // as the old postEntry balance check used to.
    const netTotalCents = toCents(ubl.netTotal);
    const vatTotalCents = toCents(ubl.vatTotal);
    const grandTotalCents = toCents(ubl.grandTotal);
    if (netTotalCents + vatTotalCents !== grandTotalCents) {
      throw new Error(
        `Inbound invoice ${ubl.invoiceNumber}: declared totals do not reconcile (net ${ubl.netTotal} + VAT ${ubl.vatTotal} ≠ grand ${ubl.grandTotal}); manual review required`,
      );
    }
    const lineNetCents = sumCents(ubl.lines.map((l) => l.net));
    if (lineNetCents !== netTotalCents) {
      throw new Error(
        `Inbound invoice ${ubl.invoiceNumber}: line net total (${fromCents(lineNetCents)}) does not reconcile with the declared net total (${ubl.netTotal}); manual review required`,
      );
    }

    const rec = await tx.query(
      `INSERT INTO einvoices(client_company_id, direction, invoice_number, issue_date, grand_total_cents, currency, ubl_xml, peppol_status, vid_status)
       VALUES ($1,'inbound',$2,$3,$4,$5,$6,'received','not_required') RETURNING id`,
      [ctx.clientCompanyId, ubl.invoiceNumber, ubl.issueDate, toCents(ubl.grandTotal).toString(), ubl.currency, msg.ublXml],
    );
    const einvoiceId = rec.rows[0].id as string;

    // The customer has no per-line expense mapping from the vendor's UBL, so all
    // lines post to the template's single expense account (accountant can re-map later).
    const vendorPartyId = await resolveOrCreateVendor(tx, ctx, ubl.supplier);
    const lineVat = reconciledLineVatCents(ubl.lines, ubl.vatTotal);
    const { billId, proposalId } = await createBill(tx, ctx, {
      vendorPartyId,
      billNumber: ubl.invoiceNumber, issueDate: ubl.issueDate, dueDate: addDays(ubl.issueDate, args.dueDays ?? 30),
      currency: ubl.currency,
      lines: ubl.lines.map((l, i) => ({
        description: l.description, expenseAccount: args.template.expenseAccount,
        net: l.net, vatRate: l.vatRate, vat: fromCents(lineVat[i]!),
      })),
      source: 'peppol', einvoiceId,
    }, args.accounts);

    billIds.push(billId);
    proposalIds.push(proposalId);
  }
  return { billIds, proposalIds, creditNoteIds };
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

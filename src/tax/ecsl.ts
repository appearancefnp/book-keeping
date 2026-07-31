import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { escapeXml } from '../xml/escape.js';
import { centsToDecimal } from './money-format.js';

export interface EcslRow {
  countryCode: string; vatNo: string;
  supplyType: 'goods' | 'services';
  netCents: string;
  /**
   * Count of contributing documents (invoices AND credit notes alike), never negative — the
   * sign of a correction lives on netCents, not here. A credit note issued in a later period
   * than the invoice it corrects is routine, so this must never be re-derived as invoices
   * minus credit notes: that reads "-1 invoices" in the UI, which looks like a bug. It is
   * also not a statutory PVN 2 field; only the net amount is.
   */
  documentCount: number;
}

export interface EcSalesList {
  period: { fromDate: string; toDate: string };
  rows: EcslRow[];
  totalNetCents: string;
  /**
   * Supplies that belong on the list but cannot be reported — no linked customer party,
   * or a party with no VAT number. VID rejects such a row outright, so these are surfaced
   * for the operator to fix rather than dropped.
   */
  issues: string[];
}

/**
 * EC Sales List (PVN 2) for a period, from the OUTBOUND document lines whose VAT category
 * puts them on the list: K (intra-Community goods) and AE (reverse-charge services, where
 * the customer accounts for the VAT). The category carries the goods/services split — see
 * ecslSupplyType in src/tax/categories.ts — so no separate goods/services column is needed.
 *
 * A credit note's OWN einvoices row never carries customer_party_id — sendCreditNote
 * (src/einvoice/outbound.ts) only sets it on the invoice path — so a credit note's
 * counterparty is resolved through corrected_invoice_number back to the invoice it
 * reverses. Skipping that resolution would put every intra-EU credit note in its own
 * "no VAT number" bucket instead of netting it against the sale it corrects.
 *
 * Credit notes are stored with POSITIVE net (same convention as bill/vendor-credit-note
 * lines — see vatBreakdown in vat-breakdown.ts) but their ledger posting REVERSES the
 * original sale. An EC Sales List reports the net value of supplies for the period, so a
 * credit note against an intra-EU supply genuinely reduces the reported figure — the
 * summed net is signed accordingly. documentCount is NOT netted the same way: it is a
 * plain count of contributing documents (invoices plus credit notes), because a credit
 * note issued in a later period than the invoice it corrects is routine and would
 * otherwise make the count negative — see EcslRow.documentCount.
 */
export async function ecSalesList(
  tx: PoolClient, ctx: TenantContext, period: { fromDate: string; toDate: string },
): Promise<EcSalesList> {
  const res = await tx.query(
    `WITH doc AS (
       SELECT e.id, e.doc_type, e.invoice_number,
              COALESCE(e.customer_party_id, orig.customer_party_id) AS customer_party_id
       FROM einvoices e
       LEFT JOIN LATERAL (
         SELECT o.customer_party_id
         FROM einvoices o
         WHERE o.client_company_id = e.client_company_id
           AND o.direction = 'outbound'
           AND o.doc_type = 'invoice'
           AND o.invoice_number = e.corrected_invoice_number
         -- (client_company_id, invoice_number) has no unique constraint anywhere — not in
         -- migrations/015_einvoices.sql or 032_credit_notes.sql, and sendInvoice
         -- (src/einvoice/outbound.ts) never checks for an existing number before inserting —
         -- so more than one outbound invoice could in principle share a number. A plain JOIN
         -- would then fan out and count the credit note's lines once per match, double- (or
         -- triple-) counting money on a statutory filing. ORDER BY + LIMIT 1 makes the
         -- resolution deterministic (oldest match wins) rather than silently arbitrary.
         ORDER BY o.created_at, o.id
         LIMIT 1
       ) orig ON true
       WHERE e.client_company_id = $1
         AND e.direction = 'outbound'
         AND e.issue_date BETWEEN $2 AND $3
     )
     SELECT d.id AS "docId", d.doc_type AS "docType", d.invoice_number AS "invoiceNumber",
            p.country_code AS "countryCode", p.vat_no AS "vatNo", p.name AS "partyName",
            CASE el.vat_category WHEN 'K' THEN 'goods' ELSE 'services' END AS "supplyType",
            el.net_cents::text AS "netCents"
     FROM einvoice_lines el
     JOIN doc d ON d.id = el.einvoice_id
     LEFT JOIN parties p ON p.id = d.customer_party_id
     WHERE el.client_company_id = $1
       AND el.vat_category IN ('K','AE')
     ORDER BY p.country_code NULLS LAST, p.vat_no NULLS LAST, "supplyType", d.invoice_number`,
    [ctx.clientCompanyId, period.fromDate, period.toDate],
  );

  interface Group {
    countryCode: string; vatNo: string; supplyType: 'goods' | 'services';
    netCents: bigint; invoiceIds: Set<string>; creditNoteIds: Set<string>;
  }
  const groups = new Map<string, Group>();
  const seenIssues = new Set<string>();
  const issues: string[] = [];

  for (const r of res.rows) {
    const isCreditNote = r.docType === 'credit_note';
    const signedNet = isCreditNote ? -BigInt(r.netCents) : BigInt(r.netCents);

    // No resolvable counterparty VAT number (missing party link, or a linked party with no
    // VAT number) — VID would reject this row outright, so name the invoice instead of
    // dropping it.
    if (!r.vatNo || !r.countryCode) {
      if (!seenIssues.has(r.invoiceNumber)) {
        seenIssues.add(r.invoiceNumber);
        const label = r.docType === 'credit_note' ? 'Credit note' : 'Invoice';
        issues.push(
          `${label} ${r.invoiceNumber}: intra-EU supply to ${r.partyName ?? 'an unlinked customer'} has no counterparty VAT number — it cannot be reported on the EC Sales List`,
        );
      }
      continue;
    }

    const key = `${r.countryCode}|${r.vatNo}|${r.supplyType}`;
    let g = groups.get(key);
    if (!g) {
      g = { countryCode: r.countryCode, vatNo: r.vatNo, supplyType: r.supplyType, netCents: 0n, invoiceIds: new Set(), creditNoteIds: new Set() };
      groups.set(key, g);
    }
    g.netCents += signedNet;
    (isCreditNote ? g.creditNoteIds : g.invoiceIds).add(r.docId);
  }

  const rows: EcslRow[] = [...groups.values()]
    .sort((a, b) =>
      a.countryCode.localeCompare(b.countryCode)
      || a.vatNo.localeCompare(b.vatNo)
      || a.supplyType.localeCompare(b.supplyType))
    .map((g) => ({
      countryCode: g.countryCode, vatNo: g.vatNo, supplyType: g.supplyType,
      netCents: g.netCents.toString(),
      // Contributing documents, invoices and credit notes alike — see EcslRow.documentCount.
      documentCount: g.invoiceIds.size + g.creditNoteIds.size,
    }));

  const totalNetCents = rows.reduce((a, r) => a + BigInt(r.netCents), 0n).toString();
  return { period, rows, totalNetCents, issues };
}

/**
 * Representative PVN 2 XML. Exact VID element names are finalized with tax-advisor input
 * (same standing caveat as toEdsXml in src/einvoice/vid.ts). Generated for review and
 * manual EDS upload — nothing transmits it; there is no filing-submission path in this
 * codebase.
 */
export function toPvn2Xml(list: EcSalesList, declarant: { vatNo: string | null }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<EcSalesList>',
    `  <DeclarantVatNo>${escapeXml(declarant.vatNo ?? '')}</DeclarantVatNo>`,
    `  <PeriodFrom>${list.period.fromDate}</PeriodFrom>`,
    `  <PeriodTo>${list.period.toDate}</PeriodTo>`,
    ...list.rows.map((r) =>
      `  <Row country="${escapeXml(r.countryCode)}" vatNo="${escapeXml(r.vatNo)}" supplyType="${r.supplyType}" net="${centsToDecimal(r.netCents)}"/>`),
    `  <TotalNet>${centsToDecimal(list.totalNetCents)}</TotalNet>`,
    '</EcSalesList>',
  ].join('\n');
}

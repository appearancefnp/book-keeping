import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { VAT_CATEGORIES, type VatCategory } from './categories.js';

export interface VatCategoryRow {
  category: VatCategory;
  salesNetCents: string; salesVatCents: string;
  purchaseNetCents: string; purchaseVatCents: string;
  /** Self-assessed reverse-charge VAT on purchases, whether deductible or not. */
  selfAssessedVatCents: string;
  /** The deductible part of the above — what the input-VAT side of the return may claim. */
  selfAssessedDeductibleCents: string;
}

export interface VatBreakdown {
  rows: VatCategoryRow[];
  /** Σ sales VAT + Σ self-assessed VAT — the document-derived counterpart of the GL output total. */
  documentOutputVatCents: string;
  /** Σ purchase VAT + Σ deductible self-assessed VAT — the counterpart of the GL input total. */
  documentInputVatCents: string;
}

const ZERO: Omit<VatCategoryRow, 'category'> = {
  salesNetCents: '0', salesVatCents: '0', purchaseNetCents: '0', purchaseVatCents: '0',
  selfAssessedVatCents: '0', selfAssessedDeductibleCents: '0',
};

/**
 * Per-category VAT aggregation from the DOCUMENTS (outbound einvoice_lines + bill_lines,
 * netted against credit notes), as opposed to computeVat's authoritative sweep of the
 * ledger. The two are compared in assembleVatDeclaration to produce the `reconciles`
 * indicator, so this aggregation must agree with the ledger on every document it counts —
 * that drives both corrections below.
 *
 * Sales read outbound documents only: an inbound Peppol invoice is recorded both as an
 * einvoice row and as a bill, and only the bill carries its line detail — see
 * src/einvoice/lines.ts.
 *
 * Credit notes are stored with POSITIVE net/vat (see src/einvoice/lines.ts and
 * src/payables/credit-notes.ts) but their GL posting REVERSES the original sale/purchase,
 * so both sides subtract them (AR via `e.doc_type = 'credit_note'`, AP via the vendor
 * credit-note UNION with sign -1) — otherwise this aggregate diverges from computeVat on
 * any period containing one.
 *
 * Both sides also require `journal_entry_id IS NOT NULL`: an unapproved bill or unapplied
 * vendor credit note has no ledger entry until its posting proposal is approved
 * (src/proposals/post-proposal.ts sets journal_entry_id then), so counting it would report
 * VAT the ledger has never seen. This is the precise "is it in the ledger?" test and
 * subsumes the old `status <> 'void'` heuristic (a voided bill is never posted).
 *
 * Self-assessed VAT is rounded PER LINE (half-up, ROUND kept INSIDE the SUM), matching
 * selfAssessedVatCents so the aggregate agrees with what buildBillEntry / buildCreditNoteEntry
 * posted — rounding the aggregate product instead would drift and produce phantom
 * cent-level mismatches in reconciliation.
 */
export async function vatBreakdown(
  tx: PoolClient, ctx: TenantContext, args: { fromDate: string; toDate: string },
): Promise<VatBreakdown> {
  const rows = new Map<VatCategory, VatCategoryRow>();
  const row = (category: VatCategory): VatCategoryRow => {
    let r = rows.get(category);
    if (!r) { r = { category, ...ZERO }; rows.set(category, r); }
    return r;
  };

  const sales = await tx.query(
    `SELECT el.vat_category AS "category",
            COALESCE(SUM(CASE WHEN e.doc_type = 'credit_note' THEN -el.net_cents ELSE el.net_cents END), 0)::text AS "netCents",
            COALESCE(SUM(CASE WHEN e.doc_type = 'credit_note' THEN -el.vat_cents ELSE el.vat_cents END), 0)::text AS "vatCents"
     FROM einvoice_lines el
     JOIN einvoices e ON e.id = el.einvoice_id
     WHERE el.client_company_id = $1
       AND e.direction = 'outbound'
       AND e.journal_entry_id IS NOT NULL
       AND e.issue_date BETWEEN $2 AND $3
     GROUP BY el.vat_category`,
    [ctx.clientCompanyId, args.fromDate, args.toDate],
  );
  for (const s of sales.rows) {
    const r = row(s.category as VatCategory);
    r.salesNetCents = s.netCents;
    r.salesVatCents = s.vatCents;
  }

  const purchases = await tx.query(
    `WITH purchase_lines AS (
       SELECT bl.vat_category, bl.net_cents, bl.vat_cents, bl.vat_rate, bl.vat_deductible, 1 AS sign
       FROM bill_lines bl
       JOIN bills b ON b.id = bl.bill_id
       WHERE bl.client_company_id = $1
         AND b.journal_entry_id IS NOT NULL
         AND b.issue_date BETWEEN $2 AND $3
       UNION ALL
       SELECT cl.vat_category, cl.net_cents, cl.vat_cents, cl.vat_rate, cl.vat_deductible, -1 AS sign
       FROM vendor_credit_note_lines cl
       JOIN vendor_credit_notes cn ON cn.id = cl.credit_note_id
       WHERE cl.client_company_id = $1
         AND cn.journal_entry_id IS NOT NULL
         AND cn.issue_date BETWEEN $2 AND $3
     )
     SELECT vat_category AS "category",
            COALESCE(SUM(sign * net_cents), 0)::text AS "netCents",
            COALESCE(SUM(sign * vat_cents), 0)::text AS "vatCents",
            COALESCE(SUM(sign * ROUND(net_cents * vat_rate / 100)), 0)::bigint::text AS "selfAssessed",
            COALESCE(SUM(CASE WHEN vat_deductible THEN sign * ROUND(net_cents * vat_rate / 100) ELSE 0 END), 0)::bigint::text AS "selfAssessedDeductible"
     FROM purchase_lines
     GROUP BY vat_category`,
    [ctx.clientCompanyId, args.fromDate, args.toDate],
  );
  for (const p of purchases.rows) {
    const category = p.category as VatCategory;
    const r = row(category);
    r.purchaseNetCents = p.netCents;
    r.purchaseVatCents = p.vatCents;
    // Only AE/K self-assess; for every other category the rate-derived sum is noise.
    if (category === 'AE' || category === 'K') {
      r.selfAssessedVatCents = p.selfAssessed;
      r.selfAssessedDeductibleCents = p.selfAssessedDeductible;
    }
  }

  const ordered = VAT_CATEGORIES.filter((c) => rows.has(c)).map((c) => rows.get(c)!);
  const sum = (pick: (r: VatCategoryRow) => string): bigint =>
    ordered.reduce((a, r) => a + BigInt(pick(r)), 0n);

  return {
    rows: ordered,
    documentOutputVatCents: (sum((r) => r.salesVatCents) + sum((r) => r.selfAssessedVatCents)).toString(),
    documentInputVatCents: (sum((r) => r.purchaseVatCents) + sum((r) => r.selfAssessedDeductibleCents)).toString(),
  };
}

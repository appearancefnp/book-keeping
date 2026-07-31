import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { computeVat, type VatConfig } from './vat-compute.js';
import { getTaxRate, type TaxRate } from './rules.js';
import { centsToDecimal } from './money-format.js';
import { escapeXml } from '../xml/escape.js';
import { vatBreakdown, type VatBreakdown } from './vat-breakdown.js';

export interface VatDeclaration {
  period: { fromDate: string; toDate: string };
  outputVat: string; inputVat: string; netPayable: string;
  ruleRef: TaxRate;
  /** Per-category detail derived from the documents (the ledger stays authoritative for the totals). */
  breakdown: VatBreakdown;
  /**
   * True when the GL totals equal the document-derived totals to the cent. False means
   * something reached a VAT account without a document behind it (typically a manual
   * journal entry) — surfaced as an indicator, never an error.
   */
  reconciles: boolean;
}

export async function assembleVatDeclaration(
  tx: PoolClient, ctx: TenantContext,
  args: { fromDate: string; toDate: string; config: VatConfig },
): Promise<VatDeclaration> {
  const v = await computeVat(tx, ctx, args);
  const ruleRef = await getTaxRate(tx, 'vat_standard_rate', args.toDate);
  const breakdown = await vatBreakdown(tx, ctx, { fromDate: args.fromDate, toDate: args.toDate });
  const reconciles =
    BigInt(v.outputVatCents) === BigInt(breakdown.documentOutputVatCents) &&
    BigInt(v.inputVatCents) === BigInt(breakdown.documentInputVatCents);

  return {
    period: { fromDate: args.fromDate, toDate: args.toDate },
    outputVat: centsToDecimal(v.outputVatCents),
    inputVat: centsToDecimal(v.inputVatCents),
    netPayable: centsToDecimal(v.netPayableCents),
    ruleRef, breakdown, reconciles,
  };
}

/** Representative EDS XML. Exact VID element names finalized in Plan 6 with tax-advisor input. */
export function toEdsXml(d: VatDeclaration): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<VatDeclaration>',
    `  <PeriodFrom>${d.period.fromDate}</PeriodFrom>`,
    `  <PeriodTo>${d.period.toDate}</PeriodTo>`,
    `  <OutputVat>${d.outputVat}</OutputVat>`,
    `  <InputVat>${d.inputVat}</InputVat>`,
    `  <NetPayable>${d.netPayable}</NetPayable>`,
    `  <RateRule type="${escapeXml(d.ruleRef.ruleType)}" value="${escapeXml(d.ruleRef.value)}" effectiveFrom="${escapeXml(d.ruleRef.effectiveFrom)}"/>`,
    `  <CategoryBreakdown>`,
    `    <Reconciliation reconciles="${d.reconciles}"/>`,
    ...d.breakdown.rows.map((r) =>
      `    <Category code="${r.category}" salesNet="${centsToDecimal(r.salesNetCents)}" salesVat="${centsToDecimal(r.salesVatCents)}" purchaseNet="${centsToDecimal(r.purchaseNetCents)}" purchaseVat="${centsToDecimal(r.purchaseVatCents)}" selfAssessedVat="${centsToDecimal(r.selfAssessedVatCents)}"/>`),
    `  </CategoryBreakdown>`,
    '</VatDeclaration>',
  ].join('\n');
}

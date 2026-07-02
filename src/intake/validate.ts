import type { ExtractedInvoice } from './extraction-schema.js';
import { toCents, sumCents } from '../db/money.js';

export interface ValidationReport { valid: boolean; issues: string[]; lowConfidenceFields: string[]; }

export function validateExtraction(
  x: ExtractedInvoice,
  confidence: Record<string, number>,
  opts: { minConfidence?: number } = {},
): ValidationReport {
  const issues: string[] = [];
  const min = opts.minConfidence ?? 0.7;

  // Line items must sum to the declared net and vat totals.
  const netFromLines = sumCents(x.lineItems.map((l) => l.net));
  const vatFromLines = sumCents(x.lineItems.map((l) => l.vat));
  if (netFromLines !== toCents(x.netTotal)) {
    issues.push(`Net total ${x.netTotal} does not reconcile with line items (${netFromLines} cents)`);
  }
  if (vatFromLines !== toCents(x.vatTotal)) {
    issues.push(`VAT total ${x.vatTotal} does not reconcile with line items (${vatFromLines} cents)`);
  }
  // Grand total must equal net + vat.
  if (toCents(x.grandTotal) !== toCents(x.netTotal) + toCents(x.vatTotal)) {
    issues.push(`Grand total ${x.grandTotal} does not equal net ${x.netTotal} + VAT ${x.vatTotal}`);
  }

  const lowConfidenceFields = Object.entries(confidence)
    .filter(([, c]) => c < min)
    .map(([field]) => field);

  return { valid: issues.length === 0, issues, lowConfidenceFields };
}

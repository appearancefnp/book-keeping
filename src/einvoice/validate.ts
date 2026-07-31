import type { EInvoice, ECreditNote } from './ubl.js';
import { toCents, sumCents } from '../db/money.js';
import { categoryIssues } from '../tax/categories.js';

/** A pragmatic subset of EN 16931 business rules relevant to the MVP (invoice or credit note). */
export function validateEn16931(inv: EInvoice | ECreditNote): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (!inv.invoiceNumber) issues.push('BR-2: invoice number is required');
  if (!inv.issueDate) issues.push('BR-3: issue date is required');
  if (!/^[A-Z]{3}$/.test(inv.currency)) issues.push('BR-5: a valid currency code is required');
  if (!inv.supplier.vatNo) issues.push('BR-CO-9: supplier VAT identifier is required');
  if (inv.lines.length === 0) issues.push('BR-16: at least one invoice line is required');

  const lineNet = sumCents(inv.lines.map((l) => l.net));
  if (lineNet !== toCents(inv.netTotal)) issues.push('BR-CO-10: line net total does not sum to the net total');
  if (toCents(inv.grandTotal) !== toCents(inv.netTotal) + toCents(inv.vatTotal)) {
    issues.push('BR-CO-15: grand total must equal net + VAT total');
  }

  // Per-line category consistency. 'sales' — this is a wire document, so an AE/K line
  // must carry a zero rate (BR-AE-5 / BR-IC-5); the purchase side passes 'purchase'.
  for (const [i, l] of inv.lines.entries()) {
    for (const issue of categoryIssues({ vatCategory: l.vatCategory ?? 'S', vatRate: l.vatRate, vatCents: toCents(l.vat) }, 'sales')) {
      issues.push(`line ${i + 1}: ${issue}`);
    }
  }

  // BR-IC-1 / BR-AE-1: a supply where the customer accounts for the VAT requires the
  // customer's VAT identifier — without it the supply cannot be reported or justified.
  const needsCustomerVat = inv.lines.some((l) => l.vatCategory === 'K' || l.vatCategory === 'AE');
  if (needsCustomerVat && !inv.customer.vatNo) {
    issues.push('BR-IC-1: an intra-Community supply or reverse-charge line requires the customer VAT identifier');
  }

  // BR-CO-14: the invoice VAT total must equal the sum of the per-category VAT amounts.
  const categoryVat = sumCents(inv.lines.map((l) => l.vat));
  if (categoryVat !== toCents(inv.vatTotal)) {
    issues.push('BR-CO-14: the VAT total must equal the sum of the category VAT amounts');
  }
  return { valid: issues.length === 0, issues };
}

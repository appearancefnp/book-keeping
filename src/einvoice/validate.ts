import type { EInvoice, ECreditNote } from './ubl.js';
import { toCents, sumCents } from '../db/money.js';

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
  return { valid: issues.length === 0, issues };
}

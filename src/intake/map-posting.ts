import type { ExtractedInvoice } from './extraction-schema.js';
import type { NewJournalEntry } from '../ledger/posting.js';

export interface PostingTemplate {
  expenseAccount: string;
  vatInputAccount: string;
  payablesAccount: string;
}

/** Map a purchase invoice to a balanced double-entry: DR expense (net), DR VAT-input (vat), CR payables (gross). */
export function extractedToJournalEntry(x: ExtractedInvoice, template: PostingTemplate): NewJournalEntry {
  return {
    date: x.date,
    memo: `Purchase — ${x.supplierName}`,
    currency: x.currency,
    lines: [
      { accountCode: template.expenseAccount, debit: x.netTotal, credit: '0', description: 'Net' },
      { accountCode: template.vatInputAccount, debit: x.vatTotal, credit: '0', description: 'VAT input' },
      { accountCode: template.payablesAccount, debit: '0', credit: x.grandTotal, description: 'Payable' },
    ],
  };
}

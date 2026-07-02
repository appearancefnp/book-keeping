import { z } from 'zod';

const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/);

export const lineItemSchema = z.object({
  description: z.string(),
  net: money,
  vatRate: z.number(),
  vat: money,
});

export const extractedInvoiceSchema = z.object({
  supplierName: z.string(),
  supplierRegNo: z.string().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().length(3),
  lineItems: z.array(lineItemSchema).min(1),
  vatTotal: money,
  netTotal: money,
  grandTotal: money,
});

export type ExtractedInvoice = z.infer<typeof extractedInvoiceSchema>;
export interface ExtractionResult { extractedData: ExtractedInvoice; confidence: Record<string, number>; }

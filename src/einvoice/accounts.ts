/**
 * Outbound sales-invoice account codes: receivable / sales / output VAT.
 *
 * Read per call rather than captured at module load so tests and per-deployment env changes take
 * effect without a reload. Defaults are the LR chart codes used across the app; overriding them by
 * env is the same stopgap the bills and pay-run routes use, and does NOT resolve the per-client
 * account-mapping debt (see the M2 follow-ups in HANDOFF.md).
 */
export function outboundInvoiceAccounts(): { receivable: string; sales: string; vat: string } {
  return {
    receivable: process.env.EINVOICE_RECEIVABLE_ACCOUNT ?? '2310',
    sales: process.env.EINVOICE_SALES_ACCOUNT ?? '6110',
    vat: process.env.EINVOICE_VAT_ACCOUNT ?? '5721',
  };
}

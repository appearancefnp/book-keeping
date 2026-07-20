import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { importStatement } from '../../src/banking/import.js';
import { makeFirmAndClient, ctx } from '../helpers/db.js';
import type { TenantContext } from '../../src/tenancy/context.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

/** Shared sample outbound invoice: grandTotal '121.00', net '100.00', vat '21.00', issueDate '2026-03-10'. */
export const SAMPLE_INVOICE: EInvoice = {
  invoiceNumber: 'INV-2026-001', issueDate: '2026-03-10', currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

/**
 * Firm/client/user/accounts/period setup shared by AR tests: opens a receivable (2310), sales
 * (6110), output VAT (5721), and bank (2620) account, opens the 2026-03 period, and creates a
 * 'customer' party.
 */
export async function setup(): Promise<{ cid: TenantContext; customerId: string }> {
  const t = await makeFirmAndClient();
  const cid = ctx(t);
  const { id: customerId } = await withTenant(cid, async (tx) => {
    await createAccount(tx, cid, { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, cid, { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, cid, { code: '5721', name: 'Output VAT', type: 'liability' });
    await createAccount(tx, cid, { code: '2620', name: 'Bank', type: 'asset' });
    await openPeriod(tx, cid, { year: 2026, month: 3 });
    return createParty(tx, cid, { kind: 'customer', name: 'SIA Klients' });
  });
  return { cid, customerId };
}

/** Issues SAMPLE_INVOICE (or an override) as an open receivable for the given customer. */
export async function issueOpenReceivable(
  cid: TenantContext, customerId: string,
  opts: { invoice?: EInvoice; dueDate?: string | null } = {},
): Promise<{ einvoiceId: string; entryId: string; messageId: string }> {
  const invoice = opts.invoice ?? SAMPLE_INVOICE;
  const dueDate = opts.dueDate ?? '2026-03-24';
  return withTenant(cid, (tx) => sendInvoice(tx, cid, {
    invoice, recipientPeppolId: '0088:test', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
    customerPartyId: customerId, dueDate,
  }));
}

/**
 * Full-stack helper for bank-match dedup tests: sets up tenant + accounts, issues SAMPLE_INVOICE
 * (grand total 12100 cents) as an open receivable, and imports one matching bank credit
 * transaction. Returns the ids needed to call settleReceivable with method: 'bank_match'.
 */
export async function issueOpenReceivableWithBankTxn(): Promise<{
  cid: TenantContext; einvoiceId: string; bankTxnId: string;
}> {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId);
  const bankTxnId = await withTenant(cid, async (tx) => {
    await importStatement(tx, cid, {
      account: 'LV80',
      transactions: [
        { bookingDate: '2026-03-20', amountCents: '12100', currency: 'EUR', side: 'credit', reference: 'INV', counterparty: 'SIA Klients', endToEndId: 'e2e-1' },
      ],
    });
    const res = await tx.query(`SELECT id FROM bank_transactions LIMIT 1`);
    return res.rows[0].id as string;
  });
  return { cid, einvoiceId, bankTxnId };
}

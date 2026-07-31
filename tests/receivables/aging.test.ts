import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { arAging } from '../../src/receivables/aging.js';
import { settleReceivable } from '../../src/receivables/settlement.js';
import { voidReceivable } from '../../src/receivables/receivables.js';
import { setup, issueOpenReceivable, SAMPLE_INVOICE } from './helpers.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';
import { toCents, fromCents } from '../../src/db/money.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

/**
 * SAMPLE_INVOICE variant with a distinct invoice number and a `grand` total split as
 * (grand - 1.00) net / 1.00 VAT — a nonzero VAT amount is required because `postEntry` rejects
 * zero-amount lines, and the output-VAT line is always posted alongside the receivable/sales
 * lines. Aging buckets by `grand_total_cents` only, so the net/VAT split is otherwise
 * irrelevant. Built via `opts.invoice` full-override on `issueOpenReceivable` — no helper
 * change needed.
 *
 * `vatRate: 21` matches SAMPLE_INVOICE's standard rate (see helpers.ts) so the line satisfies
 * BR-S-5 (a standard-rated line needs rate > 0); it does not need to match the `vat` amount
 * above, which is deliberately a token 1.00 to keep grand totals round, not a real 21% VAT calc.
 */
function invoiceWithTotal(invoiceNumber: string, grand: string): EInvoice {
  const vat = '1.00';
  const net = fromCents(toCents(grand) - toCents(vat));
  return {
    ...SAMPLE_INVOICE,
    invoiceNumber,
    lines: [{ description: 'Prece', net, vatRate: 21, vat }],
    netTotal: net, vatTotal: vat, grandTotal: grand,
  };
}

test('buckets outstanding receivables by asOf - due_date', async () => {
  const { cid, customerId } = await setup();
  await issueOpenReceivable(cid, customerId, { invoice: invoiceWithTotal('INV-A', '100.00'), dueDate: '2026-04-10' }); // 0 days -> current
  await issueOpenReceivable(cid, customerId, { invoice: invoiceWithTotal('INV-B', '50.00'), dueDate: '2026-03-25' }); // 16 days -> d1_30
  await issueOpenReceivable(cid, customerId, { invoice: invoiceWithTotal('INV-C', '30.00'), dueDate: '2026-02-01' }); // 68 days -> d61_90

  const r = await withTenant(cid, (tx) => arAging(tx, cid, { asOf: '2026-04-10' }));
  expect(r.current).toBe('100.00');
  expect(r.d1_30).toBe('50.00');
  expect(r.d31_60).toBe('0.00');
  expect(r.d61_90).toBe('30.00');
  expect(r.d90plus).toBe('0.00');
  expect(r.total).toBe('180.00');
});

test('excludes paid and void receivables', async () => {
  const { cid, customerId } = await setup();

  const paid = await issueOpenReceivable(cid, customerId, { invoice: invoiceWithTotal('INV-D', '40.00'), dueDate: '2026-04-10' });
  await withTenant(cid, (tx) => settleReceivable(tx, cid, {
    einvoiceId: paid.einvoiceId, amountCents: '4000', paidDate: '2026-03-15',
    method: 'manual', bankAccount: '2620', receivableAccount: '2310',
  }));

  const voided = await issueOpenReceivable(cid, customerId, { invoice: invoiceWithTotal('INV-E', '20.00'), dueDate: '2026-04-10' });
  await withTenant(cid, (tx) => voidReceivable(tx, cid, voided.einvoiceId));

  const r = await withTenant(cid, (tx) => arAging(tx, cid, { asOf: '2026-04-10' }));
  expect(r.total).toBe('0.00');
});

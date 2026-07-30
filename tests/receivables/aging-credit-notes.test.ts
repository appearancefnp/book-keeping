import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { arAging } from '../../src/receivables/aging.js';
import { settleReceivable } from '../../src/receivables/settlement.js';
import { sendCreditNote } from '../../src/einvoice/outbound.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { accountBalances } from '../../src/ledger/balances.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { setup, issueOpenReceivable, SAMPLE_INVOICE } from './helpers.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';
import type { ECreditNote } from '../../src/einvoice/ubl.js';
import { toCents, fromCents } from '../../src/db/money.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

/**
 * Same helper as tests/receivables/aging.test.ts: builds an invoice with a given grand total.
 * `vatRate: 21` matches SAMPLE_INVOICE's standard rate so the line satisfies BR-S-5; the `vat`
 * amount stays a token 1.00 to keep grand totals round rather than reflecting a real 21% calc.
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

// vatRate: 21 matches SAMPLE_INVOICE's standard rate for BR-S-5; `vat` stays a token 0.17 to
// keep grandTotal a round 20.00 rather than reflecting a real 21% calc on the net.
const BASE_CN: ECreditNote = {
  invoiceNumber: 'CN-2026-001', issueDate: '2026-04-10', currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Atgriešana', net: '19.83', vatRate: 21, vat: '0.17' }],
  netTotal: '19.83', vatTotal: '0.17', grandTotal: '20.00',
};

test('an unreferenced credit note nets AR aging by its issue-date age', async () => {
  const { cid, customerId } = await setup();
  await withTenant(cid, (tx) => openPeriod(tx, cid, { year: 2026, month: 4 }));
  // invoice 100.00 due 40 days before asOf -> d31_60 bucket
  await issueOpenReceivable(cid, customerId, {
    invoice: invoiceWithTotal('INV-A', '100.00'), dueDate: '2026-03-11',
  });

  // unreferenced CN 20.00 issued 10 days before asOf -> subtracts from d1_30
  await withTenant(cid, (tx) => sendCreditNote(tx, cid, {
    creditNote: BASE_CN, recipientPeppolId: '0088:123', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));

  const r = await withTenant(cid, (tx) => arAging(tx, cid, { asOf: '2026-04-20' }));
  expect(r.d31_60).toBe('100.00');
  expect(r.d1_30).toBe('-20.00');
  expect(r.total).toBe('80.00');
});

test('a fully applied credit note does not double-count in aging', async () => {
  const { cid, customerId } = await setup();
  await withTenant(cid, (tx) => openPeriod(tx, cid, { year: 2026, month: 4 }));
  await issueOpenReceivable(cid, customerId, {
    invoice: invoiceWithTotal('INV-B', '100.00'), dueDate: '2026-04-20',
  });

  // vatRate: 21 for BR-S-5 (token vat 0.34, unrelated to a real 21% calc — see BASE_CN comment).
  const cn: ECreditNote = { ...BASE_CN, invoiceNumber: 'CN-2026-002', correctedInvoiceNumber: 'INV-B', grandTotal: '40.00', netTotal: '39.66', vatTotal: '0.34', lines: [{ description: 'Atgriešana', net: '39.66', vatRate: 21, vat: '0.34' }] };
  await withTenant(cid, (tx) => sendCreditNote(tx, cid, {
    creditNote: cn, recipientPeppolId: '0088:123', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));

  const r = await withTenant(cid, (tx) => arAging(tx, cid, { asOf: '2026-04-20' }));
  expect(r.current).toBe('60.00');
  expect(r.total).toBe('60.00');
});

test('an oversized credit note nets only its unapplied remainder', async () => {
  const { cid, customerId } = await setup();
  await withTenant(cid, (tx) => openPeriod(tx, cid, { year: 2026, month: 4 }));
  await issueOpenReceivable(cid, customerId, {
    invoice: invoiceWithTotal('INV-C', '30.00'), dueDate: '2026-04-20',
  });

  // vatRate: 21 for BR-S-5 (token vat 0.83, unrelated to a real 21% calc — see BASE_CN comment).
  const cn: ECreditNote = { ...BASE_CN, invoiceNumber: 'CN-2026-003', correctedInvoiceNumber: 'INV-C', grandTotal: '100.00', netTotal: '99.17', vatTotal: '0.83', lines: [{ description: 'Atgriešana', net: '99.17', vatRate: 21, vat: '0.83' }] };
  await withTenant(cid, (tx) => sendCreditNote(tx, cid, {
    creditNote: cn, recipientPeppolId: '0088:123', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));

  const r = await withTenant(cid, (tx) => arAging(tx, cid, { asOf: '2026-04-20' }));
  expect(r.total).toBe('-70.00');
});

test('AR aging total ties to the GL receivable balance', async () => {
  const { cid, customerId } = await setup();
  await withTenant(cid, (tx) => openPeriod(tx, cid, { year: 2026, month: 4 }));
  const { einvoiceId } = await issueOpenReceivable(cid, customerId, {
    invoice: invoiceWithTotal('INV-D', '100.00'), dueDate: '2026-04-20',
  });

  await withTenant(cid, (tx) => settleReceivable(tx, cid, {
    einvoiceId, amountCents: '3000', paidDate: '2026-03-20',
    method: 'manual', bankAccount: '2620', receivableAccount: '2310',
  }));

  const referencedCn: ECreditNote = { ...BASE_CN, invoiceNumber: 'CN-2026-004', correctedInvoiceNumber: 'INV-D', grandTotal: '20.00' };
  await withTenant(cid, (tx) => sendCreditNote(tx, cid, {
    creditNote: referencedCn, recipientPeppolId: '0088:123', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));

  // vatRate: 21 for BR-S-5 (token vat 0.09, unrelated to a real 21% calc — see BASE_CN comment).
  const unreferencedCn: ECreditNote = { ...BASE_CN, invoiceNumber: 'CN-2026-005', grandTotal: '10.00', netTotal: '9.91', vatTotal: '0.09', lines: [{ description: 'Atgriešana', net: '9.91', vatRate: 21, vat: '0.09' }] };
  await withTenant(cid, (tx) => sendCreditNote(tx, cid, {
    creditNote: unreferencedCn, recipientPeppolId: '0088:123', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));

  const r = await withTenant(cid, (tx) => arAging(tx, cid, { asOf: '2026-04-20' }));
  expect(r.total).toBe('40.00');

  const balances = await withTenant(cid, (tx) => accountBalances(tx, cid, {}));
  const receivable = balances.find((b) => b.code === '2310');
  expect(receivable?.balance).toBe('40.00');
  expect(r.total).toBe(receivable?.balance);
});

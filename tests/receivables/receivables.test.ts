import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { getReceivable, listReceivables, voidReceivable } from '../../src/receivables/receivables.js';
import { setup, issueOpenReceivable, SAMPLE_INVOICE } from './helpers.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('an issued invoice is persisted as an open receivable with customer + due date', async () => {
  const { cid, customerId } = await setup(); // creates a 'customer' party, receivable/sales/vat accounts, open period
  const { einvoiceId } = await withTenant(cid, (tx) => sendInvoice(tx, cid, {
    invoice: SAMPLE_INVOICE,           // grandTotal '121.00', net '100.00', vat '21.00', issueDate '2026-03-10'
    recipientPeppolId: '0088:test', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
    customerPartyId: customerId, dueDate: '2026-03-24',
  }));
  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('open');
  expect(r.customerPartyId).toBe(customerId);
  expect(r.dueDate).toBe('2026-03-24');
  expect(r.grandTotalCents).toBe('12100');
  expect(r.amountPaidCents).toBe('0');
  expect(r.outstandingCents).toBe('12100');
});

test('falls back to the invoice dueDate when no dueDate arg is passed', async () => {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await withTenant(cid, (tx) => sendInvoice(tx, cid, {
    invoice: { ...SAMPLE_INVOICE, dueDate: '2026-04-01' },
    recipientPeppolId: '0088:test', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
    customerPartyId: customerId,
  }));
  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.dueDate).toBe('2026-04-01');
});

test('getReceivable throws for an unknown id', async () => {
  const { cid } = await setup();
  await expect(withTenant(cid, (tx) => getReceivable(tx, cid, '00000000-0000-0000-0000-000000000000')))
    .rejects.toThrow(/not found/i);
});

test('listReceivables lists open receivables and filters by status', async () => {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId);

  const all = await withTenant(cid, (tx) => listReceivables(tx, cid));
  expect(all.map((r) => r.id)).toContain(einvoiceId);

  const open = await withTenant(cid, (tx) => listReceivables(tx, cid, { status: 'open' }));
  expect(open.map((r) => r.id)).toContain(einvoiceId);

  const paid = await withTenant(cid, (tx) => listReceivables(tx, cid, { status: 'paid' }));
  expect(paid.map((r) => r.id)).not.toContain(einvoiceId);
});

test('voidReceivable marks an open receivable void, and refuses to void it twice', async () => {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId);

  await withTenant(cid, (tx) => voidReceivable(tx, cid, einvoiceId));
  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('void');

  await expect(withTenant(cid, (tx) => voidReceivable(tx, cid, einvoiceId)))
    .rejects.toThrow(/only an open receivable/i);
});

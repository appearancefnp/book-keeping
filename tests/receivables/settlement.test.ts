import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { getReceivable, voidReceivable } from '../../src/receivables/receivables.js';
import { settleReceivable } from '../../src/receivables/settlement.js';
import { setup, issueOpenReceivable, issueOpenReceivableWithBankTxn } from './helpers.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('full settlement marks the receivable paid and posts DR bank / CR receivable', async () => {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId); // grand 12100
  const { entryId } = await withTenant(cid, (tx) => settleReceivable(tx, cid, {
    einvoiceId, amountCents: '12100', paidDate: '2026-03-20', method: 'manual', bankAccount: '2620', receivableAccount: '2310',
  }));
  expect(entryId).toBeTruthy();
  const r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('paid');
  expect(r.amountPaidCents).toBe('12100');
  expect(r.outstandingCents).toBe('0');
});

test('partial settlement marks partially_paid, second settles to paid', async () => {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId);
  await withTenant(cid, (tx) => settleReceivable(tx, cid, { einvoiceId, amountCents: '5000', paidDate: '2026-03-20', method: 'manual', bankAccount: '2620', receivableAccount: '2310' }));
  let r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('partially_paid');
  await withTenant(cid, (tx) => settleReceivable(tx, cid, { einvoiceId, amountCents: '7100', paidDate: '2026-03-21', method: 'manual', bankAccount: '2620', receivableAccount: '2310' }));
  r = await withTenant(cid, (tx) => getReceivable(tx, cid, einvoiceId));
  expect(r.status).toBe('paid');
});

test('rejects over-payment beyond outstanding', async () => {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId);
  await expect(withTenant(cid, (tx) => settleReceivable(tx, cid, { einvoiceId, amountCents: '12101', paidDate: '2026-03-20', method: 'manual', bankAccount: '2620', receivableAccount: '2310' }))).rejects.toThrow(/exceeds outstanding/);
});

test('rejects settling a void receivable', async () => {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId);
  await withTenant(cid, (tx) => voidReceivable(tx, cid, einvoiceId));
  await expect(withTenant(cid, (tx) => settleReceivable(tx, cid, { einvoiceId, amountCents: '100', paidDate: '2026-03-20', method: 'manual', bankAccount: '2620', receivableAccount: '2310' }))).rejects.toThrow(/not settleable/);
});

test('rejects a second settlement referencing the same bank transaction', async () => {
  const { cid, einvoiceId, bankTxnId } = await issueOpenReceivableWithBankTxn(); // amount 12100
  await withTenant(cid, (tx) => settleReceivable(tx, cid, { einvoiceId, amountCents: '6000', paidDate: '2026-03-20', method: 'bank_match', bankTransactionId: bankTxnId, bankAccount: '2620', receivableAccount: '2310' }));
  await expect(withTenant(cid, (tx) => settleReceivable(tx, cid, { einvoiceId, amountCents: '6000', paidDate: '2026-03-21', method: 'bank_match', bankTransactionId: bankTxnId, bankAccount: '2620', receivableAccount: '2310' }))).rejects.toThrow(/already settled by bank transaction/);
});

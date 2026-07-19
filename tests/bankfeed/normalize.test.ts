import { expect, test } from 'vitest';
import { feedTxnToBankTxn } from '../../src/bankfeed/normalize.js';
import type { FeedTxn } from '../../src/bankfeed/provider.js';

const base: FeedTxn = {
  bookingDate: '2026-07-01', amount: '-12.50', currency: 'EUR',
  reference: 'INV-9', counterparty: 'SIA Piegādātājs', endToEndId: 'E2E-1', providerTxId: 'gc-tx-1',
};

test('negative amount becomes an absolute-value debit', () => {
  const t = feedTxnToBankTxn(base);
  expect(t.side).toBe('debit');
  expect(t.amountCents).toBe('1250');
});

test('positive amount becomes a credit', () => {
  const t = feedTxnToBankTxn({ ...base, amount: '100.05' });
  expect(t.side).toBe('credit');
  expect(t.amountCents).toBe('10005');
});

test('endToEndId falls back to providerTxId when the bank omits it', () => {
  expect(feedTxnToBankTxn({ ...base, endToEndId: '' }).endToEndId).toBe('gc-tx-1');
  expect(feedTxnToBankTxn(base).endToEndId).toBe('E2E-1');
});

test('invalid decimal (3 dp) throws', () => {
  expect(() => feedTxnToBankTxn({ ...base, amount: '1.005' })).toThrow(/Invalid money value/);
});

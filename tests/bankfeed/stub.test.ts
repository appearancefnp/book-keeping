import { expect, test } from 'vitest';
import { StubBankFeedProvider } from '../../src/bankfeed/stub.js';

test('consent lifecycle: pending until linked via test helper', async () => {
  const p = new StubBankFeedProvider();
  const { requisitionId, consentUrl } = await p.startConsent('STUB_BANK', 'http://x/cb', 'ref-1');
  expect(consentUrl).toContain(requisitionId);
  expect((await p.getRequisition(requisitionId)).status).toBe('pending');
  p.linkRequisition(requisitionId, [{ providerAccountId: 'acc-1', iban: 'LV11TEST0000000000001', currency: 'EUR' }], '2026-10-01T00:00:00Z');
  const req = await p.getRequisition(requisitionId);
  expect(req.status).toBe('linked');
  expect(req.accounts).toHaveLength(1);
});

test('fetchTransactions filters by fromDate and can be forced to fail', async () => {
  const p = new StubBankFeedProvider();
  p.transactionsByAccount.set('acc-1', [
    { bookingDate: '2026-06-01', amount: '5.00', currency: 'EUR', reference: '', counterparty: '', endToEndId: '', providerTxId: 'a' },
    { bookingDate: '2026-07-01', amount: '6.00', currency: 'EUR', reference: '', counterparty: '', endToEndId: '', providerTxId: 'b' },
  ]);
  expect(await p.fetchTransactions('acc-1', '2026-06-15')).toHaveLength(1);
  p.fetchErrors.set('acc-1', 'rate limited');
  await expect(p.fetchTransactions('acc-1', '2026-01-01')).rejects.toThrow('rate limited');
});

test('autoLink mode links on first getRequisition with a demo account', async () => {
  const p = new StubBankFeedProvider({ autoLink: true });
  const { requisitionId } = await p.startConsent('STUB_BANK', 'http://x/cb', 'ref-1');
  const req = await p.getRequisition(requisitionId);
  expect(req.status).toBe('linked');
  expect(req.accounts.length).toBeGreaterThan(0);
});

test('deleteRequisition records the id', async () => {
  const p = new StubBankFeedProvider();
  const { requisitionId } = await p.startConsent('STUB_BANK', 'http://x/cb', 'r');
  await p.deleteRequisition(requisitionId);
  expect(p.deleted).toContain(requisitionId);
});

test('unknown requisition throws', async () => {
  const p = new StubBankFeedProvider();
  await expect(p.getRequisition('nope')).rejects.toThrow(/not found/);
});

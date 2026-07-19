import { afterEach, expect, test, vi } from 'vitest';
import { mapRequisitionStatus, mapBookedTransaction, consentExpiry, GoCardlessProvider } from '../../src/bankfeed/gocardless.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('requisition status mapping', () => {
  expect(mapRequisitionStatus('LN')).toBe('linked');
  expect(mapRequisitionStatus('EX')).toBe('expired');
  expect(mapRequisitionStatus('RJ')).toBe('revoked');
  expect(mapRequisitionStatus('SU')).toBe('revoked');
  for (const s of ['CR', 'GC', 'UA', 'GA', 'SA', '??']) expect(mapRequisitionStatus(s)).toBe('pending');
});

test('booked transaction mapping — debit takes creditorName, remittance array joined', () => {
  const f = mapBookedTransaction({
    transactionId: 'gc-tx-9',
    bookingDate: '2026-07-15',
    transactionAmount: { amount: '-60.50', currency: 'EUR' },
    remittanceInformationUnstructuredArray: ['PO-77', 'part 2'],
    creditorName: 'SIA Piegādātājs',
  });
  expect(f).toEqual({
    bookingDate: '2026-07-15', amount: '-60.50', currency: 'EUR',
    reference: 'PO-77 part 2', counterparty: 'SIA Piegādātājs',
    endToEndId: '', providerTxId: 'gc-tx-9',
  });
});

test('booked transaction mapping — credit takes debtorName, endToEndId kept, internal id fallback', () => {
  const f = mapBookedTransaction({
    internalTransactionId: 'int-1',
    bookingDate: '2026-07-15',
    transactionAmount: { amount: '121.00', currency: 'EUR' },
    remittanceInformationUnstructured: 'INV-2026-001',
    debtorName: 'SIA Klients',
    endToEndId: 'INV-2026-001',
  });
  expect(f.counterparty).toBe('SIA Klients');
  expect(f.endToEndId).toBe('INV-2026-001');
  expect(f.providerTxId).toBe('int-1');
  expect(f.amount).toBe('121.00');
});

test('consent expiry = accepted + access_valid_for_days', () => {
  expect(consentExpiry('2026-07-19T10:00:00Z', 90)).toBe('2026-10-17T10:00:00.000Z');
  expect(consentExpiry(null, 90)).toBeNull();
  expect(consentExpiry('2026-07-19T10:00:00Z', null)).toBeNull();
});

test('network failure (fetch rejects) is normalized to the bank feed provider prefix', async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')));
  const provider = new GoCardlessProvider('id', 'key');
  await expect(provider.listInstitutions('lv')).rejects.toThrow(/^bank feed provider/);
});

test('malformed JSON body is normalized to the bank feed provider prefix', async () => {
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('not json', { status: 200 })));
  const provider = new GoCardlessProvider('id', 'key');
  await expect(provider.listInstitutions('lv')).rejects.toThrow(/^bank feed provider/);
});

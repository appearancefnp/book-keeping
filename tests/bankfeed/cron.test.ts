import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { randomUUID } from 'node:crypto';
import { StubBankFeedProvider } from '../../src/bankfeed/stub.js';
import { createConnection, finalizeConnection, listConnections } from '../../src/bankfeed/connections.js';
import { syncAllClients } from '../../src/bankfeed/cron.js';
import type { FeedTxn } from '../../src/bankfeed/provider.js';

const TODAY = '2026-07-19';
const txn = (id: string): FeedTxn => ({ bookingDate: '2026-07-10', amount: '10.00', currency: 'EUR',
  reference: '', counterparty: '', endToEndId: '', providerTxId: id });

async function linked(t: { firmId: string; clientCompanyId: string }, p: StubBankFeedProvider, acc: string) {
  const connectionId = randomUUID();
  await withTenant(ctx(t), (tx) =>
    createConnection(tx, ctx(t), p, { connectionId, institutionId: 'STUB_BANK', institutionName: 'Stub', redirectUrl: 'http://x' }));
  const reqId = (await withTenant(ctx(t), (tx) => listConnections(tx, ctx(t))))[0]!.providerRequisitionId;
  p.linkRequisition(reqId, [{ providerAccountId: acc, iban: `LV${acc.padStart(19, '0')}`, currency: 'EUR' }], null);
  await withTenant(ctx(t), (tx) => finalizeConnection(tx, ctx(t), p, connectionId));
  return connectionId;
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('syncs linked connections across two clients with a system context', async () => {
  const a = await makeFirmAndClient('SIA A');
  const b = await makeFirmAndClient('SIA B');
  const p = new StubBankFeedProvider();
  await linked(a, p, '1');
  await linked(b, p, '2');
  p.transactionsByAccount.set('1', [txn('a1')]);
  p.transactionsByAccount.set('2', [txn('b1')]);

  const r = await syncAllClients(p, TODAY);
  expect(r).toEqual({ synced: 2, failed: 0 });
  for (const t of [a, b]) {
    const n = await withTenant(ctx(t), async (tx) => (await tx.query('SELECT count(*)::int AS n FROM bank_transactions')).rows[0].n);
    expect(n).toBe(1);
  }
  // audit attributed to the system actor
  const actor = await withTenant(ctx(a), async (tx) =>
    (await tx.query(`SELECT actor_id FROM audit_log WHERE action = 'sync' LIMIT 1`)).rows[0].actor_id);
  expect(actor).toBe('system:bank-sync');
});

test('one failing connection does not block the other client', async () => {
  const a = await makeFirmAndClient('SIA A');
  const b = await makeFirmAndClient('SIA B');
  const p = new StubBankFeedProvider();
  await linked(a, p, '1');
  await linked(b, p, '2');
  p.transactionsByAccount.set('2', [txn('b1')]);
  // getRequisition failure = connection-level failure (not per-account)
  const reqA = (await withTenant(ctx(a), (tx) => listConnections(tx, ctx(a))))[0]!;
  p.setStatus(reqA.providerRequisitionId, 'pending');
  const orig = p.getRequisition.bind(p);
  p.getRequisition = async (id: string) => {
    if (id === reqA.providerRequisitionId) throw new Error('provider down');
    return orig(id);
  };

  const r = await syncAllClients(p, TODAY);
  expect(r).toEqual({ synced: 1, failed: 1 });
  const connA = (await withTenant(ctx(a), (tx) => listConnections(tx, ctx(a))))[0]!;
  expect(connA.lastError).toMatch(/provider down/);
  const nB = await withTenant(ctx(b), async (tx) => (await tx.query('SELECT count(*)::int AS n FROM bank_transactions')).rows[0].n);
  expect(nB).toBe(1);
});

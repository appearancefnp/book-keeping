import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { randomUUID } from 'node:crypto';
import { StubBankFeedProvider } from '../../src/bankfeed/stub.js';
import { createConnection, finalizeConnection, listConnections, deleteConnection } from '../../src/bankfeed/connections.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('create → pending row with consent url; finalize stores accounts and links', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const connectionId = randomUUID();
  const created = await withTenant(ctx(t), (tx) =>
    createConnection(tx, ctx(t), p, { connectionId, institutionId: 'STUB_BANK', institutionName: 'Stub Bank', redirectUrl: 'http://x/bank/callback?cid=' + connectionId }));
  expect(created.consentUrl).toContain('stub-req-1');

  let list = await withTenant(ctx(t), (tx) => listConnections(tx, ctx(t)));
  expect(list).toHaveLength(1);
  expect(list[0]!.status).toBe('pending');

  // finalize while provider still pending → stays pending, no accounts
  let fin = await withTenant(ctx(t), (tx) => finalizeConnection(tx, ctx(t), p, connectionId));
  expect(fin.status).toBe('pending');
  expect(fin.accounts).toHaveLength(0);

  p.linkRequisition('stub-req-1', [{ providerAccountId: 'acc-1', iban: 'LV11TEST0000000000001', currency: 'EUR' }], '2026-10-01T00:00:00Z');
  fin = await withTenant(ctx(t), (tx) => finalizeConnection(tx, ctx(t), p, connectionId));
  expect(fin.status).toBe('linked');
  expect(fin.accounts.map((a) => a.iban)).toEqual(['LV11TEST0000000000001']);
  expect(fin.consentExpiresAt).not.toBeNull();

  // finalize is idempotent on accounts
  fin = await withTenant(ctx(t), (tx) => finalizeConnection(tx, ctx(t), p, connectionId));
  expect(fin.accounts).toHaveLength(1);
});

test('RLS: another client sees no connections', async () => {
  const a = await makeFirmAndClient('SIA A');
  const b = await makeFirmAndClient('SIA B');
  const p = new StubBankFeedProvider();
  await withTenant(ctx(a), (tx) =>
    createConnection(tx, ctx(a), p, { connectionId: randomUUID(), institutionId: 'STUB_BANK', institutionName: 'Stub', redirectUrl: 'http://x' }));
  expect(await withTenant(ctx(b), (tx) => listConnections(tx, ctx(b)))).toHaveLength(0);
});

test('delete removes rows and best-effort deletes the requisition', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  const connectionId = randomUUID();
  await withTenant(ctx(t), (tx) =>
    createConnection(tx, ctx(t), p, { connectionId, institutionId: 'STUB_BANK', institutionName: 'Stub', redirectUrl: 'http://x' }));
  await withTenant(ctx(t), (tx) => deleteConnection(tx, ctx(t), p, connectionId));
  expect(p.deleted).toContain('stub-req-1');
  expect(await withTenant(ctx(t), (tx) => listConnections(tx, ctx(t)))).toHaveLength(0);
});

test('unknown connection throws not found', async () => {
  const t = await makeFirmAndClient();
  const p = new StubBankFeedProvider();
  await expect(withTenant(ctx(t), (tx) => finalizeConnection(tx, ctx(t), p, randomUUID())))
    .rejects.toThrow(/not found/);
});

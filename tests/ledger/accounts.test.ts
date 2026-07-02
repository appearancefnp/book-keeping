import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount, listAccounts } from '../../src/ledger/accounts.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('creates accounts and lists them ordered by code', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '1000', name: 'Fixed assets', type: 'asset' });
  });
  const rows = await withTenant(ctx(t), (tx) => listAccounts(tx, ctx(t)));
  expect(rows.map((r) => r.code)).toEqual(['1000', '2310']);
});

test('rejects a duplicate account code for the same client', async () => {
  const t = await makeFirmAndClient();
  await expect(
    withTenant(ctx(t), async (tx) => {
      await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
      await createAccount(tx, ctx(t), { code: '2310', name: 'Dup', type: 'asset' });
    }),
  ).rejects.toThrow();
});

test('rejects an invalid account type', async () => {
  const t = await makeFirmAndClient();
  await expect(
    withTenant(ctx(t), (tx) => createAccount(tx, ctx(t), { code: '9', name: 'X', type: 'bogus' as never })),
  ).rejects.toThrow();
});

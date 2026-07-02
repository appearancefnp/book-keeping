import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('a tenant cannot read another tenant rows via RLS', async () => {
  const a = await makeFirmAndClient('Client A');
  const b = await makeFirmAndClient('Client B');

  await withTenant(ctx(a), async (tx) => {
    await tx.query(
      "INSERT INTO accounts(client_company_id, code, name, type) VALUES ($1,'1000','Cash','asset')",
      [a.clientCompanyId],
    );
  });

  const seenByB = await withTenant(ctx(b), async (tx) => {
    const r = await tx.query('SELECT code FROM accounts');
    return r.rows;
  });
  expect(seenByB).toHaveLength(0);

  const seenByA = await withTenant(ctx(a), async (tx) => {
    const r = await tx.query('SELECT code FROM accounts');
    return r.rows.map((row) => row.code);
  });
  expect(seenByA).toEqual(['1000']);
});

test('WITH CHECK blocks inserting a row for another tenant', async () => {
  const a = await makeFirmAndClient('Client A');
  const b = await makeFirmAndClient('Client B');
  await expect(
    withTenant(ctx(a), async (tx) => {
      await tx.query(
        "INSERT INTO accounts(client_company_id, code, name, type) VALUES ($1,'2000','Sneaky','asset')",
        [b.clientCompanyId], // trying to write into B while scoped to A
      );
    }),
  ).rejects.toThrow(/row-level security/i);
});

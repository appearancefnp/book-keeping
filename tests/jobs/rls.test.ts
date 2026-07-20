import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker } from '../../src/db/pool.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('worker sees jobs across all tenants; app sees only its own', async () => {
  const a = ctx(await makeFirmAndClient('SIA A'));
  const b = ctx(await makeFirmAndClient('SIA B'));
  for (const t of [a, b]) {
    await withTenant(t, (tx) => tx.query(
      `INSERT INTO jobs(client_company_id, firm_id, type, run_at) VALUES ($1,$2,'test',now())`,
      [t.clientCompanyId, t.firmId],
    ));
  }
  const workerSees = await withWorker((tx) => tx.query(`SELECT id FROM jobs`));
  expect(workerSees.rowCount).toBe(2);

  const appSeesA = await withTenant(a, (tx) => tx.query(`SELECT id FROM jobs`));
  expect(appSeesA.rowCount).toBe(1);
});

test('bookkeeping_worker has no privilege on business tables', async () => {
  await expect(
    withWorker((tx) => tx.query(`SELECT id FROM einvoices LIMIT 1`)),
  ).rejects.toThrow(/permission denied/i);
});

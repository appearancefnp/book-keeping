import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { adminPool, withTenant } from '../../src/db/pool.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('jobs table and worker role exist after migration', async () => {
  const cols = await adminPool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'jobs' ORDER BY column_name`,
  );
  const names = cols.rows.map((r) => r.column_name);
  expect(names).toEqual(expect.arrayContaining([
    'id', 'client_company_id', 'firm_id', 'type', 'status', 'run_at',
    'payload', 'dedup_key', 'attempts', 'max_attempts', 'last_error',
    'claimed_at', 'created_at', 'updated_at',
  ]));

  const role = await adminPool.query(`SELECT 1 FROM pg_roles WHERE rolname = 'bookkeeping_worker'`);
  expect(role.rowCount).toBe(1);
});

test('bookkeeping_app tenant isolation: a client cannot see another client\'s jobs', async () => {
  const a = ctx(await makeFirmAndClient('SIA A'));
  const b = ctx(await makeFirmAndClient('SIA B'));

  await withTenant(a, (tx) => tx.query(
    `INSERT INTO jobs(client_company_id, firm_id, type, run_at) VALUES ($1,$2,'test',now())`,
    [a.clientCompanyId, a.firmId],
  ));

  const seenByB = await withTenant(b, (tx) => tx.query(`SELECT id FROM jobs`));
  expect(seenByB.rowCount).toBe(0);

  const seenByA = await withTenant(a, (tx) => tx.query(`SELECT id FROM jobs`));
  expect(seenByA.rowCount).toBe(1);
});

import { afterAll, beforeAll, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { appPool } from '../../src/db/pool.js';

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('migrations create the schema_migrations bookkeeping table', async () => {
  const res = await appPool.query(
    "SELECT filename FROM schema_migrations ORDER BY filename",
  );
  expect(res.rows.map((r) => r.filename)).toContain('001_firms_clients.sql');
});

test('app role is not a superuser (so RLS applies)', async () => {
  const res = await appPool.query(
    "SELECT rolsuper FROM pg_roles WHERE rolname = current_user",
  );
  expect(res.rows[0].rolsuper).toBe(false);
});

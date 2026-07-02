import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('TRUNCATE journal_entries is rejected for app role', async () => {
  const t = await makeFirmAndClient();
  await expect(
    withTenant(ctx(t), (tx) => tx.query('TRUNCATE journal_entries')),
  ).rejects.toThrow(/permission denied/i);
});

test('UPDATE journal_lines is rejected for app role', async () => {
  const t = await makeFirmAndClient();
  await expect(
    withTenant(ctx(t), (tx) => tx.query("UPDATE journal_lines SET description = 'x'")),
  ).rejects.toThrow(/permission denied/i);
});

test('DELETE FROM journal_entries is rejected for app role', async () => {
  const t = await makeFirmAndClient();
  await expect(
    withTenant(ctx(t), (tx) => tx.query('DELETE FROM journal_entries')),
  ).rejects.toThrow(/permission denied/i);
});

test('ALTER TABLE to disable append-only trigger is rejected for app role', async () => {
  const t = await makeFirmAndClient();
  await expect(
    withTenant(ctx(t), (tx) =>
      tx.query('ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_append_only'),
    ),
  ).rejects.toThrow(/permission denied|must be owner/i);
});

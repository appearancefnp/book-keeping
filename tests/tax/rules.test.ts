import { afterAll, beforeAll, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { adminPool } from '../../src/db/pool.js';
import { getTaxRate } from '../../src/tax/rules.js';

beforeAll(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('returns the rate effective on the given date', async () => {
  // tax_rules is global — query via a client that resolves it (no tenant scoping needed).
  const client = await adminPool.connect();
  try {
    const r = await getTaxRate(client, 'vat_standard_rate', '2026-03-10');
    expect(r.value).toBe('21');
    expect(r.effectiveFrom).toBe('2013-01-01');
  } finally { client.release(); }
});

test('returns the latest rule at or before the date (not a future one)', async () => {
  const client = await adminPool.connect();
  try {
    await client.query("INSERT INTO tax_rules(rule_type, value, effective_from) VALUES ('vat_standard_rate','20','2030-01-01')");
    const now = await getTaxRate(client, 'vat_standard_rate', '2026-03-10');
    expect(now.value).toBe('21'); // 2030 rule not yet effective
    const future = await getTaxRate(client, 'vat_standard_rate', '2031-01-01');
    expect(future.value).toBe('20');
  } finally { client.release(); }
});

test('throws for an unknown rule type', async () => {
  const client = await adminPool.connect();
  try {
    await expect(getTaxRate(client, 'nonexistent', '2026-03-10')).rejects.toThrow();
  } finally { client.release(); }
});

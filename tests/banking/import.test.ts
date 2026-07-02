import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { importStatement } from '../../src/banking/import.js';
import type { BankStatement } from '../../src/banking/camt-parser.js';

const stmt: BankStatement = {
  account: 'LV80BANK0000435195001',
  transactions: [
    { bookingDate: '2026-03-10', amountCents: '12100', currency: 'EUR', side: 'credit', reference: 'INV-1', counterparty: 'SIA Klients', endToEndId: 'INV-2026-001' },
    { bookingDate: '2026-03-11', amountCents: '6050', currency: 'EUR', side: 'debit', reference: 'PO-77', counterparty: 'SIA Piegādātājs', endToEndId: 'PO-77' },
  ],
};

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('imports transactions and is idempotent on re-import', async () => {
  const t = await makeFirmAndClient();
  const first = await withTenant(ctx(t), (tx) => importStatement(tx, ctx(t), stmt));
  expect(first.imported).toBe(2);
  expect(first.skipped).toBe(0);
  const second = await withTenant(ctx(t), (tx) => importStatement(tx, ctx(t), stmt));
  expect(second.imported).toBe(0);
  expect(second.skipped).toBe(2);
  const rows = await withTenant(ctx(t), async (tx) => (await tx.query('SELECT count(*)::int AS n FROM bank_transactions')).rows[0].n);
  expect(rows).toBe(2);
});

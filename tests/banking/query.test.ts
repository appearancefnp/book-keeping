import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { importStatement } from '../../src/banking/import.js';
import { listBankTransactions } from '../../src/banking/query.js';
import type { BankStatement } from '../../src/banking/camt-parser.js';

const stmt: BankStatement = {
  account: 'LV12BANK0000000000001',
  transactions: [
    { bookingDate: '2026-03-05', amountCents: '12100', currency: 'EUR', side: 'credit', reference: 'INV-1', counterparty: 'SIA Klients', endToEndId: 'E2E-1' },
    { bookingDate: '2026-03-06', amountCents: '5000', currency: 'EUR', side: 'debit', reference: 'Rent', counterparty: 'SIA Namsaimnieks', endToEndId: 'E2E-2' },
  ],
};

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('lists imported transactions newest-first with status', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => importStatement(tx, ctx(t), stmt));
  const rows = await withTenant(ctx(t), (tx) => listBankTransactions(tx, ctx(t)));
  expect(rows).toHaveLength(2);
  expect(rows[0]!.bookingDate).toBe('2026-03-06');
  expect(rows[0]!.status).toBe('unmatched');
  expect(rows[1]!.amountCents).toBe('12100');
  expect(rows[1]!.side).toBe('credit');
});

test('filters by status and scopes to tenant', async () => {
  const t1 = await makeFirmAndClient('SIA Viens');
  const t2 = await makeFirmAndClient('SIA Divi');
  await withTenant(ctx(t1), (tx) => importStatement(tx, ctx(t1), stmt));
  const matched = await withTenant(ctx(t1), (tx) => listBankTransactions(tx, ctx(t1), { status: 'matched' }));
  expect(matched).toHaveLength(0);
  const other = await withTenant(ctx(t2), (tx) => listBankTransactions(tx, ctx(t2)));
  expect(other).toHaveLength(0);
});

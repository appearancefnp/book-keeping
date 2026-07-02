import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { generateSepaCreditTransfer, outstandingReceivables } from '../../src/banking/sepa.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('generates well-formed pain.001 with a payment line', () => {
  const xml = generateSepaCreditTransfer([{ iban: 'LV80BANK0000435195001', amount: '60.50', reference: 'PO-77' }]);
  expect(xml).toMatch(/^<\?xml/);
  expect(xml).toContain('CstmrCdtTrfInitn');
  expect(xml).toContain('<IBAN>LV80BANK0000435195001</IBAN>');
  expect(xml).toContain('60.50');
});

test('outstandingReceivables returns the net debit balance on the receivables account', async () => {
  const t = await makeFirmAndClient();
  const bal = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '121.00' },
    ]});
    return outstandingReceivables(tx, ctx(t), '2310');
  });
  expect(bal.balanceCents).toBe('12100');
});

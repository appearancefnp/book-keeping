import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { computeVat } from '../../src/tax/vat-compute.js';

const config = { outputVatAccount: '5721', inputVatAccount: '5722' };

async function seed(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expense', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await createAccount(tx, ctx(t), { code: '5722', name: 'Input VAT', type: 'asset' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    // A sale: DR bank 121, CR sales 100, CR output VAT 21
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
      { accountCode: '5721', debit: '0', credit: '21.00' },
    ]});
    // A purchase: DR expense 50, DR input VAT 10.50, CR bank 60.50
    await postEntry(tx, ctx(t), { date: '2026-03-06', memo: 'Purchase', currency: 'EUR', lines: [
      { accountCode: '7710', debit: '50.00', credit: '0' },
      { accountCode: '5722', debit: '10.50', credit: '0' },
      { accountCode: '2310', debit: '0', credit: '60.50' },
    ]});
  });
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('computes output, input, and net payable VAT for the period', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const v = await withTenant(ctx(t), (tx) => computeVat(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31', config }));
  expect(v.outputVatCents).toBe('2100');
  expect(v.inputVatCents).toBe('1050');
  expect(v.netPayableCents).toBe('1050'); // 2100 - 1050
  expect(v.contributions.length).toBe(2);
});

test('excludes entries outside the period', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const v = await withTenant(ctx(t), (tx) => computeVat(tx, ctx(t), { fromDate: '2026-04-01', toDate: '2026-04-30', config }));
  expect(v.outputVatCents).toBe('0');
  expect(v.inputVatCents).toBe('0');
  expect(v.netPayableCents).toBe('0');
});

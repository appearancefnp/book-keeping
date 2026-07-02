import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { assembleVatDeclaration, toEdsXml } from '../../src/tax/vat-declaration.js';

const config = { outputVatAccount: '5721', inputVatAccount: '5722' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seedSale(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
      { accountCode: '5721', debit: '0', credit: '21.00' },
    ]});
  });
}

test('assembles a declaration with decimal figures and a rule reference', async () => {
  const t = await makeFirmAndClient();
  await seedSale(t);
  const d = await withTenant(ctx(t), (tx) => assembleVatDeclaration(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31', config }));
  expect(d.outputVat).toBe('21.00');
  expect(d.inputVat).toBe('0.00');
  expect(d.netPayable).toBe('21.00');
  expect(d.ruleRef.ruleType).toBe('vat_standard_rate');
  expect(d.ruleRef.value).toBe('21');
});

test('renders well-formed EDS XML containing the figures', async () => {
  const t = await makeFirmAndClient();
  await seedSale(t);
  const d = await withTenant(ctx(t), (tx) => assembleVatDeclaration(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31', config }));
  const xml = toEdsXml(d);
  expect(xml).toMatch(/^<\?xml/);
  expect(xml).toContain('<NetPayable>21.00</NetPayable>');
  expect(xml).toContain('<PeriodFrom>2026-03-01</PeriodFrom>');
});

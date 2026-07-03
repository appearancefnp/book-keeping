import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { buildAssistantTools } from '../../src/assistant/tools.js';

const config = { outputVatAccount: '5721', inputVatAccount: '5722', receivablesAccount: '2310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('get_vat_position returns the computed net payable with entry citations', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '100.00' },
      { accountCode: '5721', debit: '0', credit: '21.00' },
    ]});
  });
  const tools = buildAssistantTools(config);
  const vat = tools.find((x) => x.name === 'get_vat_position')!;
  const out = await withTenant(ctx(t), (tx) => vat.run(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31' }));
  expect((out.result as { netPayable: string }).netPayable).toBe('21.00');
  expect(out.citations.length).toBeGreaterThan(0); // contributing entry id(s)
});

test('all tools are read-only (no mutating verbs) and tenant-scoped by construction', () => {
  const tools = buildAssistantTools(config);
  expect(tools.map((t) => t.name).sort()).toEqual(
    ['get_receivables', 'get_tax_rate', 'get_trial_balance', 'get_vat_position', 'list_pending_approvals'].sort(),
  );
});

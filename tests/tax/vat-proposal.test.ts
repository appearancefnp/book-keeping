import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { createVatDeclarationProposal } from '../../src/tax/vat-proposal.js';
import { setAutonomy } from '../../src/autonomy/autonomy.js';

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

test('creates a declaration proposal in pending_approval (never auto)', async () => {
  const t = await makeFirmAndClient();
  await seedSale(t);
  // Even if someone sets declaration autonomy to auto, the guardrail forces approval.
  await withTenant(ctx(t), (tx) => setAutonomy(tx, ctx(t), { operationType: 'declaration', mode: 'auto' }));
  const { proposalId } = await withTenant(ctx(t), (tx) => createVatDeclarationProposal(tx, ctx(t), { fromDate: '2026-03-01', toDate: '2026-03-31', config }));
  const p = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect(p.type).toBe('declaration');
  expect(p.status).toBe('pending_approval');
  expect((p.payload as { netPayable: string }).netPayable).toBe('21.00');
  expect((p.rationale as { xml?: string }).xml).toContain('<NetPayable>21.00</NetPayable>');
});

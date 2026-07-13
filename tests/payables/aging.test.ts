import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { createBill } from '../../src/payables/bills.js';
import { apAging } from '../../src/payables/aging.js';

const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function billDue(t: { firmId: string; clientCompanyId: string }, dueDate: string, net: string, num: string) {
  return withTenant(ctx(t), async (tx) => {
    const v = await createParty(tx, ctx(t), { kind: 'vendor', name: num });
    const b = await createBill(tx, ctx(t), {
      vendorPartyId: v.id, billNumber: num, issueDate: '2026-01-01', dueDate, currency: 'EUR',
      lines: [{ description: 'x', expenseAccount: '7710', net, vatRate: 0, vat: '0.00' }],
    }, ACCTS);
    await approveProposal(tx, ctx(t), b.proposalId);
    await postApprovedPosting(tx, ctx(t), b.proposalId);
    return b.billId;
  });
}

test('apAging buckets outstanding by due date vs asOf', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    for (const [code, type] of [['7710','expense'],['5721','asset'],['5310','liability']] as const) await createAccount(tx, ctx(t), { code, name: code, type });
    for (const m of [1,2,3,4,5,6]) await openPeriod(tx, ctx(t), { year: 2026, month: m });
  });
  await billDue(t, '2026-07-01', '100.00', 'A'); // asOf 2026-06-15 → not due → current
  await billDue(t, '2026-06-01', '50.00', 'B');  // 14 days overdue → 1–30
  await billDue(t, '2026-04-01', '20.00', 'C');  // 75 days overdue → 61–90
  const aging = await withTenant(ctx(t), (tx) => apAging(tx, ctx(t), { asOf: '2026-06-15' }));
  expect(aging.current).toBe('100.00');
  expect(aging.d1_30).toBe('50.00');
  expect(aging.d61_90).toBe('20.00');
  expect(aging.total).toBe('170.00');
});

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { createBill, getBill } from '../../src/payables/bills.js';
import { createPayRun } from '../../src/payables/pay-run.js';

const ACCTS = { vatInputAccount: '5721', vatOutputAccount: '5721', payablesAccount: '5310' };
const PR_ACCTS = { payablesAccount: '5310', bankClearingAccount: '2699' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function openBill(t: { firmId: string; clientCompanyId: string }, iban: string | null, num: string) {
  return withTenant(ctx(t), async (tx) => {
    const v = await createParty(tx, ctx(t), { kind: 'vendor', name: `V-${num}`, iban });
    const b = await createBill(tx, ctx(t), {
      vendorPartyId: v.id, billNumber: num, issueDate: '2026-03-01', dueDate: '2026-03-31', currency: 'EUR',
      lines: [{ description: 'x', expenseAccount: '7710', net: '100.00', vatRate: 0, vat: '0.00', vatCategory: 'Z' }],
    }, ACCTS);
    await approveProposal(tx, ctx(t), b.proposalId);
    await postApprovedPosting(tx, ctx(t), b.proposalId);
    return b.billId;
  });
}

async function accounts(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    for (const [code, type] of [['7710','expense'],['5721','asset'],['5310','liability'],['2620','asset'],['2699','asset']] as const) {
      await createAccount(tx, ctx(t), { code, name: code, type });
    }
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
  });
}

test('createPayRun settles bills to bank-clearing and emits pain.001', async () => {
  const t = await makeFirmAndClient();
  await accounts(t);
  const b1 = await openBill(t, 'LV80BANK0000435195001', 'P-1');
  const res = await withTenant(ctx(t), (tx) => createPayRun(tx, ctx(t), { billIds: [b1], paidDate: '2026-03-20', accounts: PR_ACCTS }));
  expect(res.totalCents).toBe('10000');
  expect(res.pain001Xml).toContain('pain.001');
  expect(res.pain001Xml).toContain('LV80BANK0000435195001');
  const b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), b1));
  expect(b.status).toBe('paid');
});

test('a bill whose vendor lacks an IBAN is rejected before posting', async () => {
  const t = await makeFirmAndClient();
  await accounts(t);
  const b1 = await openBill(t, null, 'P-2');
  await expect(withTenant(ctx(t), (tx) => createPayRun(tx, ctx(t), { billIds: [b1], paidDate: '2026-03-20', accounts: PR_ACCTS })))
    .rejects.toThrow(/IBAN/i);
  const b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), b1));
  expect(b.status).toBe('open'); // unchanged
});

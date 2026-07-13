import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { postApprovedBankMatch } from '../../src/banking/confirm-match.js';
import { proposeApMatches } from '../../src/banking/match.js';
import { createBill, getBill } from '../../src/payables/bills.js';
import { createPayRun } from '../../src/payables/pay-run.js';
import { accountBalances } from '../../src/ledger/balances.js';

const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };
const AP_MATCH = { payablesAccount: '5310', bankAccount: '2620', bankClearingAccount: '2699' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    for (const [code, type] of [['7710','expense'],['5721','asset'],['5310','liability'],['2620','asset'],['2699','asset']] as const) {
      await createAccount(tx, ctx(t), { code, name: code, type });
    }
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
  });
  return t;
}
async function openBill(t: { firmId: string; clientCompanyId: string }, num: string, iban: string | null) {
  return withTenant(ctx(t), async (tx) => {
    const v = await createParty(tx, ctx(t), { kind: 'vendor', name: num, iban });
    const b = await createBill(tx, ctx(t), {
      vendorPartyId: v.id, billNumber: num, issueDate: '2026-03-01', dueDate: '2026-03-31', currency: 'EUR',
      lines: [{ description: 'x', expenseAccount: '7710', net: '100.00', vatRate: 0, vat: '0.00' }],
    }, ACCTS);
    await approveProposal(tx, ctx(t), b.proposalId);
    await postApprovedPosting(tx, ctx(t), b.proposalId);
    return b.billId;
  });
}
async function importDebit(t: { firmId: string; clientCompanyId: string }, amountCents: string) {
  await withTenant(ctx(t), (tx) => tx.query(
    `INSERT INTO bank_transactions(client_company_id, account, booking_date, amount_cents, currency, side, reference, end_to_end_id)
     VALUES ($1,'LV00TEST','2026-03-20',$2,'EUR','debit','pay','E2E-1')`,
    [ctx(t).clientCompanyId, amountCents]));
}

test('pay-run debit clears the transit account to zero', async () => {
  const t = await setup();
  const billId = await openBill(t, 'C-1', 'LV80BANK0000435195001');
  await withTenant(ctx(t), (tx) => createPayRun(tx, ctx(t), { billIds: [billId], paidDate: '2026-03-20', accounts: { payablesAccount: '5310', bankClearingAccount: '2699' } }));
  await importDebit(t, '10000');
  const { proposalIds } = await withTenant(ctx(t), (tx) => proposeApMatches(tx, ctx(t), AP_MATCH));
  expect(proposalIds).toHaveLength(1);
  await withTenant(ctx(t), async (tx) => { await approveProposal(tx, ctx(t), proposalIds[0]!); await postApprovedBankMatch(tx, ctx(t), proposalIds[0]!); });
  const rows = await withTenant(ctx(t), (tx) => accountBalances(tx, ctx(t), {}));
  expect(rows.find((r) => r.code === '2699')!.balance).toBe('0.00'); // transit netted to zero
});

test('non-pay-run debit settles an open bill directly', async () => {
  const t = await setup();
  const billId = await openBill(t, 'C-2', null); // no pay run
  await importDebit(t, '10000');
  const { proposalIds } = await withTenant(ctx(t), (tx) => proposeApMatches(tx, ctx(t), AP_MATCH));
  expect(proposalIds).toHaveLength(1);
  await withTenant(ctx(t), async (tx) => { await approveProposal(tx, ctx(t), proposalIds[0]!); await postApprovedBankMatch(tx, ctx(t), proposalIds[0]!); });
  const b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(b.status).toBe('paid');
});

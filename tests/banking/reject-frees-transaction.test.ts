import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { importStatement } from '../../src/banking/import.js';
import { proposeArMatches } from '../../src/banking/match.js';
import { rejectProposal } from '../../src/proposals/lifecycle.js';
import { setup, issueOpenReceivable } from '../receivables/helpers.js';
import type { TenantContext } from '../../src/tenancy/context.js';

// proposeMatches (GL-level, account-balance matching) was retired in favour of the
// invoice-linked proposeArMatches (see src/banking/match.ts) — matches are now proposed
// against OPEN INVOICES (einvoices), not raw GL account balance. Mirror the fixture used
// by tests/banking/match.test.ts: issue a real open receivable via sendInvoice, then a
// matching bank credit.
const config = { receivableAccount: '2310', bankAccount: '2620' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setupAndPropose(): Promise<{ cid: TenantContext; proposalIds: string[] }> {
  const { cid, customerId } = await setup();
  await issueOpenReceivable(cid, customerId); // grand total 12100 cents
  await withTenant(cid, (tx) => importStatement(tx, cid, {
    account: 'LV80',
    transactions: [
      { bookingDate: '2026-03-20', amountCents: '12100', currency: 'EUR', side: 'credit', reference: 'pmt', counterparty: 'SIA Klients', endToEndId: 'E1' },
    ],
  }));
  const proposalIds = await withTenant(cid, (tx) => proposeArMatches(tx, cid, config).then((r) => r.proposalIds));
  return { cid, proposalIds };
}

async function txnStatus(cid: TenantContext): Promise<string> {
  const r = await withTenant(cid, (tx) =>
    tx.query(`SELECT status FROM bank_transactions WHERE client_company_id = $1`, [cid.clientCompanyId]));
  return r.rows[0].status as string;
}

test('rejecting a bank_match (invoice-linked receivable_direct) reverts the transaction to unmatched and allows re-proposing', async () => {
  const { cid, proposalIds } = await setupAndPropose();
  expect(proposalIds).toHaveLength(1);
  expect(await txnStatus(cid)).toBe('matched');

  await withTenant(cid, (tx) => rejectProposal(tx, cid, proposalIds[0]!, 'wrong candidate'));
  expect(await txnStatus(cid)).toBe('unmatched');

  // The freed transaction is picked up again on the next propose run.
  const again = await withTenant(cid, (tx) => proposeArMatches(tx, cid, config));
  expect(again.proposalIds).toHaveLength(1);
});

test('rejecting a non-bank_match proposal touches no bank transaction', async () => {
  const { cid, proposalIds } = await setupAndPropose();
  expect(await txnStatus(cid)).toBe('matched');
  // Reject an unrelated task proposal — the matched transaction must stay matched.
  const { createProposal } = await import('../../src/proposals/proposals.js');
  const { id } = await withTenant(cid, (tx) =>
    createProposal(tx, cid, { type: 'task', payload: {}, rationale: {}, status: 'pending_approval' }));
  await withTenant(cid, (tx) => rejectProposal(tx, cid, id, 'no'));
  expect(await txnStatus(cid)).toBe('matched');
  expect(proposalIds).toHaveLength(1);
});

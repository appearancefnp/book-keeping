import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { createUser } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login } from '../../src/auth/sessions.js';
import { assignUserToClient } from '../../src/auth/context.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createProposal } from '../../src/proposals/proposals.js';
import { submitForApproval } from '../../src/proposals/lifecycle.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { importStatement } from '../../src/banking/import.js';
import { approvalQueueHandler, approveHandler, rejectHandler, financialsHandler } from '../../src/api/handlers.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const firm = await createFirm('Firm');
  const client = await createClientCompany(firm.id, { name: 'SIA K', regNo: '40100000000' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: 'a@b.lv', password: 'password123', role: 'accountant' });
  await assignUserToClient(userId, client.id);
  const { sessionToken } = await login('a@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  // seed a posting proposal in pending_approval
  const cid = { firmId: firm.id, clientCompanyId: client.id, actorId: userId, actorRole: 'accountant' };
  const proposalId = await withTenant(cid, async (tx) => {
    await createAccount(tx, cid, { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, cid, { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, cid, { year: 2026, month: 3 });
    const { id } = await createProposal(tx, cid, {
      type: 'posting',
      payload: { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
        { accountCode: '2310', debit: '121.00', credit: '0' }, { accountCode: '6110', debit: '0', credit: '121.00' },
      ]},
      rationale: { ruleRef: 'x' },
    });
    await submitForApproval(tx, cid, id);
    return id;
  });
  return { clientId: client.id, sessionToken, proposalId };
}

test('approval queue handler returns pending proposals for the authed client', async () => {
  const { clientId, sessionToken } = await setup();
  const res = await approvalQueueHandler({ token: sessionToken, clientCompanyId: clientId, atUnixSeconds: NOW });
  expect(res.status).toBe(200);
  expect((res.body as { proposals: unknown[] }).proposals).toHaveLength(1);
});

test('approve handler approves AND posts a posting proposal (keystone)', async () => {
  const { clientId, sessionToken, proposalId } = await setup();
  const res = await approveHandler({ token: sessionToken, clientCompanyId: clientId, params: { id: proposalId }, atUnixSeconds: NOW });
  expect(res.status).toBe(200);
  expect((res.body as { entryId: string }).entryId).toBeTruthy();
});

test('handler rejects an unauthenticated request', async () => {
  const { clientId, proposalId } = await setup();
  const res = await approveHandler({ token: 'bogus', clientCompanyId: clientId, params: { id: proposalId }, atUnixSeconds: NOW });
  expect(res.status).toBe(401);
});

// Fix 1 — bank_match approve dispatch
test('approve handler approves AND posts a bank_match proposal', async () => {
  const firm = await createFirm('Firm2');
  const client = await createClientCompany(firm.id, { name: 'SIA M', regNo: '40100000001' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: 'b@b.lv', password: 'password123', role: 'accountant' });
  await assignUserToClient(userId, client.id);
  const { sessionToken } = await login('b@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  const cid = { firmId: firm.id, clientCompanyId: client.id, actorId: userId, actorRole: 'accountant' };

  const bankMatchProposalId = await withTenant(cid, async (tx) => {
    await createAccount(tx, cid, { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, cid, { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, cid, { code: '2620', name: 'Bank', type: 'asset' });
    await openPeriod(tx, cid, { year: 2026, month: 3 });
    // Post a credit sale creating a 121.00 receivable
    const { id: saleProposalId } = await createProposal(tx, cid, {
      type: 'posting',
      payload: { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
        { accountCode: '2310', debit: '121.00', credit: '0' },
        { accountCode: '6110', debit: '0', credit: '121.00' },
      ]},
      rationale: { ruleRef: 'x' },
    });
    await submitForApproval(tx, cid, saleProposalId);
    return saleProposalId;
  });

  // Approve the posting so the receivable entry exists
  await approveHandler({ token: sessionToken, clientCompanyId: client.id, params: { id: bankMatchProposalId }, atUnixSeconds: NOW });

  // Import a matching bank statement credit and propose matches
  const proposalId = await withTenant(cid, async (tx) => {
    await importStatement(tx, cid, {
      account: '2620',
      transactions: [{
        bookingDate: '2026-03-11',
        amountCents: '12100',
        currency: 'EUR',
        side: 'credit',
        reference: 'INV-001',
        counterparty: 'Customer',
        endToEndId: 'e2e-001',
      }],
    });
    const txnId = (await tx.query('SELECT id FROM bank_transactions LIMIT 1')).rows[0].id as string;
    const { id: pid } = await createProposal(tx, cid, {
      type: 'bank_match',
      payload: { bankTransactionId: txnId, amountCents: '12100', bankAccount: '2620', receivablesAccount: '2310' },
      rationale: { ruleRef: 'bank-match-amount' },
      status: 'pending_approval',
    });
    await tx.query(`UPDATE bank_transactions SET status='matched' WHERE id=$1 AND client_company_id=$2`, [txnId, cid.clientCompanyId]);
    return pid;
  });

  expect(proposalId).toBeTruthy();
  const res = await approveHandler({ token: sessionToken, clientCompanyId: client.id, params: { id: proposalId }, atUnixSeconds: NOW });
  expect(res.status).toBe(200);
  expect((res.body as { entryId: string }).entryId).toBeTruthy();
});

// Fix 2 — rejectHandler tests
test('rejectHandler returns ok:true and proposal ends rejected with reason', async () => {
  const firm = await createFirm('FirmR');
  const client = await createClientCompany(firm.id, { name: 'SIA R', regNo: '40100000002' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: 'r@b.lv', password: 'password123', role: 'accountant' });
  await assignUserToClient(userId, client.id);
  const { sessionToken } = await login('r@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  const cid = { firmId: firm.id, clientCompanyId: client.id, actorId: userId, actorRole: 'accountant' };

  const rejectedProposalId = await withTenant(cid, async (tx) => {
    await createAccount(tx, cid, { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, cid, { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, cid, { year: 2026, month: 3 });
    const { id } = await createProposal(tx, cid, {
      type: 'posting',
      payload: { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [
        { accountCode: '2310', debit: '121.00', credit: '0' }, { accountCode: '6110', debit: '0', credit: '121.00' },
      ]},
      rationale: { ruleRef: 'x' },
    });
    await submitForApproval(tx, cid, id);
    return id;
  });

  const res = await rejectHandler({ token: sessionToken, clientCompanyId: client.id, params: { id: rejectedProposalId }, body: { reason: 'wrong amount' }, atUnixSeconds: NOW });
  expect(res.status).toBe(200);
  expect((res.body as { ok: boolean }).ok).toBe(true);

  const prop = await withTenant(cid, (tx) => getProposal(tx, cid, rejectedProposalId));
  expect(prop.status).toBe('rejected');
  expect(prop.rejectReason).toBe('wrong amount');
});

test('rejectHandler returns 400 when id is missing', async () => {
  const { clientId, sessionToken } = await setup();
  const res = await rejectHandler({ token: sessionToken, clientCompanyId: clientId, params: {}, atUnixSeconds: NOW });
  expect(res.status).toBe(400);
});

// Fix 3 — financialsHandler tests
test('financialsHandler returns 200 with trialBalance array after posting an entry', async () => {
  const { clientId, sessionToken, proposalId } = await setup();
  // Post the proposal first so there are ledger entries
  await approveHandler({ token: sessionToken, clientCompanyId: clientId, params: { id: proposalId }, atUnixSeconds: NOW });
  const res = await financialsHandler({ token: sessionToken, clientCompanyId: clientId, atUnixSeconds: NOW });
  expect(res.status).toBe(200);
  expect(Array.isArray((res.body as { trialBalance: unknown[] }).trialBalance)).toBe(true);
});

test('financialsHandler returns 401 for bogus token', async () => {
  const { clientId } = await setup();
  const res = await financialsHandler({ token: 'bogus-token', clientCompanyId: clientId, atUnixSeconds: NOW });
  expect(res.status).toBe(401);
});

// Task 3 — recurring_invoice approve dispatch
test('approving a recurring_invoice proposal issues the invoice', async () => {
  const firm = await createFirm('FirmRec');
  const client = await createClientCompany(firm.id, { name: 'SIA Rec', regNo: '40100000003' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: 'rec@b.lv', password: 'password123', role: 'accountant' });
  await assignUserToClient(userId, client.id);
  const { sessionToken } = await login('rec@b.lv', 'password123', totpCodeFor(totpSecret, NOW), NOW);
  const cid = { firmId: firm.id, clientCompanyId: client.id, actorId: userId, actorRole: 'accountant' };

  // Park an invoice in a pending_approval recurring_invoice proposal, the same shape
  // generateDueRecurring writes when autonomy is not 'auto'.
  const invoice = {
    invoiceNumber: 'INV-2026-05-abcdef12', issueDate: '2026-05-10', currency: 'EUR',
    supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
    customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
    lines: [{ description: 'Abonēšana', net: '100.00', vatRate: 21, vat: '21.00' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  };

  const proposalId = await withTenant(cid, async (tx) => {
    await createAccount(tx, cid, { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, cid, { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, cid, { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, cid, { year: 2026, month: 5 });
    const { id } = await createProposal(tx, cid, {
      type: 'recurring_invoice',
      payload: { invoice, recipientPeppolId: '0088:test', customerPartyId: null, dueDate: null },
      rationale: { computation: 'recurring invoice for 2026-05' },
      status: 'pending_approval',
    });
    return id;
  });

  const res = await approveHandler({
    token: sessionToken, clientCompanyId: client.id, params: { id: proposalId }, atUnixSeconds: NOW,
  });

  expect(res.status).toBe(200);
  expect((res.body as { entryId: string | null }).entryId).toBeTruthy();

  const inv = await withTenant(cid, (tx) => tx.query(
    `SELECT invoice_number FROM einvoices WHERE direction = 'outbound'`));
  expect(inv.rows[0].invoice_number).toBe('INV-2026-05-abcdef12');
});

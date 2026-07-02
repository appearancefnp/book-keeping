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
import { approvalQueueHandler, approveHandler } from '../../src/api/handlers.js';

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

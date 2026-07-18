import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createFirm, createClientCompany } from '../../src/tenancy/firms.js';
import { createUser, type UserRole } from '../../src/auth/users.js';
import { totpCodeFor } from '../../src/auth/totp.js';
import { login } from '../../src/auth/sessions.js';
import { assignUserToClient } from '../../src/auth/context.js';
import { createProposal, getProposal } from '../../src/proposals/proposals.js';
import { approveHandler, rejectHandler } from '../../src/api/handlers.js';

const NOW = 1_700_000_000;

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup(role: UserRole) {
  const firm = await createFirm('Firm');
  const client = await createClientCompany(firm.id, { name: 'SIA K', regNo: '40100000001' });
  const { id: userId, totpSecret } = await createUser({ firmId: firm.id, email: `${role}@t.lv`, password: 'password123', role });
  await assignUserToClient(userId, client.id);
  const { sessionToken } = await login(`${role}@t.lv`, 'password123', totpCodeFor(totpSecret, NOW), NOW);
  const cid = { firmId: firm.id, clientCompanyId: client.id, actorId: userId, actorRole: role };
  // A 'task' proposal: approval-only, no ledger post — perfect for authz tests.
  const { id: proposalId } = await withTenant(cid, (tx) =>
    createProposal(tx, cid, { type: 'task', payload: {}, rationale: {}, status: 'pending_approval' }));
  return { clientId: client.id, sessionToken, cid, proposalId };
}

test('employee may not reject a proposal (403, status unchanged)', async () => {
  const { clientId, sessionToken, cid, proposalId } = await setup('employee');
  const res = await rejectHandler({
    token: sessionToken, clientCompanyId: clientId, params: { id: proposalId },
    body: { reason: 'nope' }, atUnixSeconds: NOW,
  });
  expect(res.status).toBe(403);
  const p = await withTenant(cid, (tx) => getProposal(tx, cid, proposalId));
  expect(p.status).toBe('pending_approval');
});

test('employee may not approve a proposal (403)', async () => {
  const { clientId, sessionToken, proposalId } = await setup('employee');
  const res = await approveHandler({
    token: sessionToken, clientCompanyId: clientId, params: { id: proposalId }, atUnixSeconds: NOW,
  });
  expect(res.status).toBe(403);
});

test('accountant approves; owner rejects (both allowed)', async () => {
  const a = await setup('accountant');
  const ra = await approveHandler({
    token: a.sessionToken, clientCompanyId: a.clientId, params: { id: a.proposalId }, atUnixSeconds: NOW,
  });
  expect(ra.status).toBe(200);

  const o = await setup('owner');
  const ro = await rejectHandler({
    token: o.sessionToken, clientCompanyId: o.clientId, params: { id: o.proposalId },
    body: { reason: 'not now' }, atUnixSeconds: NOW,
  });
  expect(ro.status).toBe(200);
});

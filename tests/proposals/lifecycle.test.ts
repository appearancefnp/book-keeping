import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createProposal, getProposal } from '../../src/proposals/proposals.js';
import { submitForApproval, approveProposal, rejectProposal } from '../../src/proposals/lifecycle.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function mk(t: { firmId: string; clientCompanyId: string }, status?: 'suggested' | 'pending_approval') {
  return withTenant(ctx(t), (tx) => createProposal(tx, ctx(t), { type: 'task', payload: {}, rationale: {}, status }));
}

test('submit → approve happy path', async () => {
  const t = await makeFirmAndClient();
  const { id } = await mk(t);
  await withTenant(ctx(t), (tx) => submitForApproval(tx, ctx(t), id));
  expect((await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), id))).status).toBe('pending_approval');
  await withTenant(ctx(t), (tx) => approveProposal(tx, ctx(t), id));
  expect((await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), id))).status).toBe('approved');
});

test('reject records a reason', async () => {
  const t = await makeFirmAndClient();
  const { id } = await mk(t, 'pending_approval');
  await withTenant(ctx(t), (tx) => rejectProposal(tx, ctx(t), id, 'wrong account'));
  const p = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), id));
  expect(p.status).toBe('rejected');
  expect(p.rejectReason).toBe('wrong account');
});

test('cannot approve a proposal that is not pending_approval', async () => {
  const t = await makeFirmAndClient();
  const { id } = await mk(t); // status 'suggested'
  await expect(withTenant(ctx(t), (tx) => approveProposal(tx, ctx(t), id))).rejects.toThrow(/pending_approval|transition/i);
});

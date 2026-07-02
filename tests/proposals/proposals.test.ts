import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createProposal, getProposal, listProposals } from '../../src/proposals/proposals.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('creates a proposal with payload + rationale, default status suggested', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createProposal(tx, ctx(t), {
    type: 'posting',
    payload: { date: '2026-03-10', memo: 'Sale', currency: 'EUR', lines: [] },
    rationale: { ruleRef: 'VAT 21%', computation: '100 + 21', sourceRefs: { documentId: null } },
  }));
  const p = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), id));
  expect(p.status).toBe('suggested');
  expect(p.type).toBe('posting');
  expect(p.rationale).toMatchObject({ ruleRef: 'VAT 21%' });
});

test('listProposals filters to the approval queue', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await createProposal(tx, ctx(t), { type: 'posting', payload: {}, rationale: {}, status: 'pending_approval' });
    await createProposal(tx, ctx(t), { type: 'task', payload: {}, rationale: {} });
  });
  const queue = await withTenant(ctx(t), (tx) => listProposals(tx, ctx(t), { status: 'pending_approval' }));
  expect(queue).toHaveLength(1);
  expect(queue[0].type).toBe('posting');
});

test('proposal core fields are immutable (payload cannot be updated)', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createProposal(tx, ctx(t), { type: 'task', payload: { a: 1 }, rationale: {} }));
  await expect(withTenant(ctx(t), (tx) =>
    tx.query("UPDATE proposals SET payload = '{\"a\":2}'::jsonb WHERE id = $1", [id]),
  )).rejects.toThrow(/immutable/i);
});

test('rejects an invalid type', async () => {
  const t = await makeFirmAndClient();
  await expect(withTenant(ctx(t), (tx) => createProposal(tx, ctx(t), { type: 'bogus' as never, payload: {}, rationale: {} }))).rejects.toThrow();
});

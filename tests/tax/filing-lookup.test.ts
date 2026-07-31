import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createProposal, type Rationale } from '../../src/proposals/proposals.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { findFilingProposal } from '../../src/tax/filing-lookup.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const PERIOD = { fromDate: '2026-03-01', toDate: '2026-03-31' };

async function makeFiling(t: ReturnType<typeof ctx>, type: 'declaration' | 'ecsl', period = PERIOD) {
  return withTenant(t, (tx) => createProposal(tx, t, {
    type, payload: {}, status: 'pending_approval',
    rationale: { computation: 'x', sourceRefs: { period }, xml: '<Doc/>' } as Rationale,
  }));
}

test('finds a prepared filing for its period and type', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await makeFiling(t, 'declaration');

  const found = await withTenant(t, (tx) => findFilingProposal(tx, t, { type: 'declaration', ...PERIOD }));
  expect(found).toEqual({ id, status: 'pending_approval' });
});

test('reflects the approved status', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await makeFiling(t, 'ecsl');
  await withTenant(t, (tx) => approveProposal(tx, t, id));

  const found = await withTenant(t, (tx) => findFilingProposal(tx, t, { type: 'ecsl', ...PERIOD }));
  expect(found?.status).toBe('approved');
});

test('does not confuse the two filing types or other periods', async () => {
  const t = ctx(await makeFirmAndClient());
  await makeFiling(t, 'declaration');

  expect(await withTenant(t, (tx) => findFilingProposal(tx, t, { type: 'ecsl', ...PERIOD }))).toBeNull();
  expect(await withTenant(t, (tx) => findFilingProposal(tx, t, {
    type: 'declaration', fromDate: '2026-04-01', toDate: '2026-04-30',
  }))).toBeNull();
});

test('returns the newest filing when a period was prepared twice', async () => {
  const t = ctx(await makeFirmAndClient());
  await makeFiling(t, 'declaration');
  const { id: second } = await makeFiling(t, 'declaration');

  const found = await withTenant(t, (tx) => findFilingProposal(tx, t, { type: 'declaration', ...PERIOD }));
  expect(found?.id).toBe(second);
});

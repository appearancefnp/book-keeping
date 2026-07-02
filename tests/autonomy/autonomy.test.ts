import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { setAutonomy, resolveAutonomy } from '../../src/autonomy/autonomy.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('defaults to approval when no policy exists', async () => {
  const t = await makeFirmAndClient();
  const mode = await withTenant(ctx(t), (tx) => resolveAutonomy(tx, ctx(t), 'posting', { amountCents: 5000n }));
  expect(mode).toBe('approval');
});

test('auto when policy says auto and below threshold', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => setAutonomy(tx, ctx(t), { operationType: 'posting', mode: 'auto', materialThresholdCents: 100000n }));
  const mode = await withTenant(ctx(t), (tx) => resolveAutonomy(tx, ctx(t), 'posting', { amountCents: 5000n }));
  expect(mode).toBe('auto');
});

test('guardrail: at/above material threshold forces approval even when policy is auto', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => setAutonomy(tx, ctx(t), { operationType: 'posting', mode: 'auto', materialThresholdCents: 100000n }));
  const mode = await withTenant(ctx(t), (tx) => resolveAutonomy(tx, ctx(t), 'posting', { amountCents: 100000n }));
  expect(mode).toBe('approval');
});

test('guardrail: declarations always require approval', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), (tx) => setAutonomy(tx, ctx(t), { operationType: 'declaration', mode: 'auto', materialThresholdCents: 100000n }));
  const mode = await withTenant(ctx(t), (tx) => resolveAutonomy(tx, ctx(t), 'declaration', { amountCents: 1n }));
  expect(mode).toBe('approval');
});

import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { setAutonomy, listAutonomyPolicies } from '../../src/autonomy/autonomy.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('lists configured policies with thresholds as strings', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    await setAutonomy(tx, ctx(t), { operationType: 'posting', mode: 'auto', materialThresholdCents: 50000n });
    await setAutonomy(tx, ctx(t), { operationType: 'bank_match', mode: 'approval' });
  });
  const policies = await withTenant(ctx(t), (tx) => listAutonomyPolicies(tx, ctx(t)));
  expect(policies).toHaveLength(2);
  const posting = policies.find((p) => p.operationType === 'posting')!;
  expect(posting.mode).toBe('auto');
  expect(posting.materialThresholdCents).toBe('50000');
});

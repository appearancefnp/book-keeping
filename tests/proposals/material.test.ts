import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createProposal } from '../../src/proposals/proposals.js';
import { setAutonomy } from '../../src/autonomy/autonomy.js';
import { listMaterialApprovals } from '../../src/proposals/material.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

// A balanced posting proposal for `amount` (decimal string), pending approval.
function posting(amount: string) {
  return {
    type: 'posting' as const,
    status: 'pending_approval' as const,
    payload: {
      date: '2026-07-01', currency: 'EUR', memo: 'x',
      lines: [
        { accountCode: '6110', debit: amount, credit: '0' },
        { accountCode: '5310', debit: '0', credit: amount },
      ],
    },
    rationale: { ruleRef: 'r' },
  };
}

test('includes postings at/above the material threshold, excludes below', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await setAutonomy(tx, c, { operationType: 'posting', mode: 'approval', materialThresholdCents: 50000n }); // €500
    await createProposal(tx, c, posting('600.00')); // 60000c ≥ 50000 → material
    await createProposal(tx, c, posting('400.00')); // 40000c < 50000 → not
  });
  const rows = await withTenant(c, (tx) => listMaterialApprovals(tx, c));
  expect(rows.length).toBe(1);
});

test('always includes declarations regardless of amount', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await setAutonomy(tx, c, { operationType: 'posting', mode: 'approval', materialThresholdCents: 100000n });
    await createProposal(tx, c, {
      type: 'declaration', status: 'pending_approval', payload: { netPayable: '12.00' }, rationale: {},
    });
  });
  const rows = await withTenant(c, (tx) => listMaterialApprovals(tx, c));
  expect(rows.length).toBe(1);
  expect(rows[0]!.type).toBe('declaration');
});

test('applies the default €1000 threshold when no autonomy policy row exists', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await createProposal(tx, c, posting('1500.00')); // 150000 ≥ 100000 default → material
    await createProposal(tx, c, posting('900.00'));  // 90000 < 100000 → not
  });
  const rows = await withTenant(c, (tx) => listMaterialApprovals(tx, c));
  expect(rows.length).toBe(1);
});

test('only returns pending_approval proposals', async () => {
  const t = await makeFirmAndClient();
  const c = ctx(t);
  await withTenant(c, async (tx) => {
    await createProposal(tx, c, { ...posting('2000.00'), status: 'approved' });
  });
  const rows = await withTenant(c, (tx) => listMaterialApprovals(tx, c));
  expect(rows.length).toBe(0);
});

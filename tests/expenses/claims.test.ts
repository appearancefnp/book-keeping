import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { setup } from './helpers.js';
import { saveClaim, getClaim, listClaims, deleteDraft, mileageNetCents } from '../../src/expenses/claims.js';
import { setMileageRate } from '../../src/expenses/settings.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const RECEIPT_LINE = {
  kind: 'receipt' as const, lineDate: '2026-07-01', description: 'Taxi', expenseAccount: '7760',
  net: '10.00', vat: '2.10', vatDeductible: true,
};
const MILEAGE_LINE_12_5 = {
  kind: 'mileage' as const, lineDate: '2026-07-02', description: 'Client visit', expenseAccount: '7760',
  km: '12.5',
};

test('creates a draft with receipt + mileage lines and computes totals server-side', async () => {
  const f = await setup();
  const { claimId } = await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeAId, description: 'July expenses',
    lines: [RECEIPT_LINE, MILEAGE_LINE_12_5],
  }));

  const claim = await withTenant(f.accountantCtx, (tx) => getClaim(tx, f.accountantCtx, claimId));
  expect(claim.status).toBe('draft');
  expect(claim.employeeId).toBe(f.employeeAId);
  expect(claim.totalNetCents).toBe('1375');
  expect(claim.totalVatCents).toBe('210');
  expect(claim.totalCents).toBe('1585');
  expect(claim.lines).toHaveLength(2);

  const receipt = claim.lines.find((l) => l.kind === 'receipt')!;
  expect(receipt.netCents).toBe('1000');
  expect(receipt.vatCents).toBe('210');
  expect(receipt.vatDeductible).toBe(true);

  const mileage = claim.lines.find((l) => l.kind === 'mileage')!;
  expect(mileage.netCents).toBe('375');
  expect(mileage.vatCents).toBe('0');
  expect(mileage.vatDeductible).toBe(false);
  expect(mileage.rateCents).toBe('30'); // default mileage rate
  expect(mileage.km).toBe('12.5');

  // Assert the DB row directly too.
  const raw = await withTenant(f.accountantCtx, (tx) => tx.query(
    `SELECT total_net_cents, total_vat_cents, total_cents FROM expense_claims WHERE id = $1`, [claimId],
  ));
  expect(raw.rows[0].total_net_cents).toBe('1375');
  expect(raw.rows[0].total_vat_cents).toBe('210');
  expect(raw.rows[0].total_cents).toBe('1585');
});

test('mileage rounds half-up on the km fraction', async () => {
  expect(mileageNetCents('0.5', 25n)).toBe(13n);

  const f = await setup();
  await withTenant(f.accountantCtx, (tx) => setMileageRate(tx, f.accountantCtx, '25'));
  const { claimId } = await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeAId, description: 'Short trip',
    lines: [{ kind: 'mileage', lineDate: '2026-07-03', description: 'Errand', expenseAccount: '7760', km: '0.5' }],
  }));
  const claim = await withTenant(f.accountantCtx, (tx) => getClaim(tx, f.accountantCtx, claimId));
  expect(claim.lines[0]!.netCents).toBe('13');
  expect(claim.lines[0]!.rateCents).toBe('25');
  expect(claim.totalCents).toBe('13');
});

test('update replaces lines wholesale and recomputes totals; only drafts are editable', async () => {
  const f = await setup();
  const { claimId } = await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeAId, description: 'Draft', lines: [RECEIPT_LINE],
  }));

  await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    claimId, description: 'Updated', lines: [MILEAGE_LINE_12_5],
  }));
  const updated = await withTenant(f.accountantCtx, (tx) => getClaim(tx, f.accountantCtx, claimId));
  expect(updated.description).toBe('Updated');
  expect(updated.lines).toHaveLength(1);
  expect(updated.lines[0]!.kind).toBe('mileage');
  expect(updated.totalNetCents).toBe('375');
  expect(updated.totalCents).toBe('375');

  await withTenant(f.accountantCtx, (tx) => tx.query(
    `UPDATE expense_claims SET status = 'submitted' WHERE id = $1`, [claimId],
  ));
  await expect(withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    claimId, description: 'Should fail', lines: [RECEIPT_LINE],
  }))).rejects.toThrow(/only draft claims can be edited/i);
});

test('employee ctx may only save/get/list their own claims', async () => {
  const f = await setup();
  await expect(withTenant(f.employeeACtx, (tx) => saveClaim(tx, f.employeeACtx, {
    employeeId: f.employeeBId, description: 'Sneaky', lines: [RECEIPT_LINE],
  }))).rejects.toThrow(/forbidden/i);

  const { claimId: ownClaimId } = await withTenant(f.employeeACtx, (tx) => saveClaim(tx, f.employeeACtx, {
    description: 'Mine', lines: [RECEIPT_LINE],
  }));
  const own = await withTenant(f.employeeACtx, (tx) => getClaim(tx, f.employeeACtx, ownClaimId));
  expect(own.employeeId).toBe(f.employeeAId);

  const { claimId: bClaimId } = await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeBId, description: "B's claim", lines: [RECEIPT_LINE],
  }));
  await expect(withTenant(f.employeeACtx, (tx) => getClaim(tx, f.employeeACtx, bClaimId)))
    .rejects.toThrow(/forbidden/i);

  const list = await withTenant(f.employeeACtx, (tx) => listClaims(tx, f.employeeACtx, {}));
  expect(list).toHaveLength(1);
  expect(list[0]!.id).toBe(ownClaimId);
});

test('owner ctx writes self-scoped but lists all claims', async () => {
  const f = await setup();
  await expect(withTenant(f.ownerCtx, (tx) => saveClaim(tx, f.ownerCtx, {
    employeeId: f.employeeAId, description: 'Not mine', lines: [RECEIPT_LINE],
  }))).rejects.toThrow(/forbidden/i);

  const { claimId: ownerClaimId } = await withTenant(f.ownerCtx, (tx) => saveClaim(tx, f.ownerCtx, {
    description: 'Owner claim', lines: [RECEIPT_LINE],
  }));
  const ownerClaim = await withTenant(f.ownerCtx, (tx) => getClaim(tx, f.ownerCtx, ownerClaimId));
  expect(ownerClaim.employeeId).toBe(f.ownerEmployeeId);

  await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeAId, description: "A's claim", lines: [RECEIPT_LINE],
  }));
  await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeBId, description: "B's claim", lines: [RECEIPT_LINE],
  }));

  const all = await withTenant(f.ownerCtx, (tx) => listClaims(tx, f.ownerCtx, {}));
  expect(all).toHaveLength(3);
});

test('accountant saves a claim for any employee', async () => {
  const f = await setup();
  const { claimId } = await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeBId, description: "B's claim via accountant", lines: [RECEIPT_LINE],
  }));
  const claim = await withTenant(f.accountantCtx, (tx) => getClaim(tx, f.accountantCtx, claimId));
  expect(claim.employeeId).toBe(f.employeeBId);
});

test('unlinked employee user gets a clear "not linked" error', async () => {
  const f = await setup();
  await expect(withTenant(f.unlinkedCtx, (tx) => saveClaim(tx, f.unlinkedCtx, {
    description: 'Should fail', lines: [RECEIPT_LINE],
  }))).rejects.toThrow(/not linked to an employee/i);

  await expect(withTenant(f.unlinkedCtx, (tx) => listClaims(tx, f.unlinkedCtx, {})))
    .rejects.toThrow(/not linked to an employee/i);
});

test('deleteDraft removes claim + lines; refuses non-drafts', async () => {
  const f = await setup();
  const { claimId } = await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeAId, description: 'Draft to delete', lines: [RECEIPT_LINE],
  }));
  await withTenant(f.accountantCtx, (tx) => deleteDraft(tx, f.accountantCtx, claimId));
  await expect(withTenant(f.accountantCtx, (tx) => getClaim(tx, f.accountantCtx, claimId)))
    .rejects.toThrow(/not found/i);
  const lines = await withTenant(f.accountantCtx, (tx) => tx.query(
    `SELECT * FROM expense_claim_lines WHERE claim_id = $1`, [claimId],
  ));
  expect(lines.rowCount).toBe(0);

  const { claimId: claimId2 } = await withTenant(f.accountantCtx, (tx) => saveClaim(tx, f.accountantCtx, {
    employeeId: f.employeeAId, description: 'Submitted', lines: [RECEIPT_LINE],
  }));
  await withTenant(f.accountantCtx, (tx) => tx.query(
    `UPDATE expense_claims SET status = 'submitted' WHERE id = $1`, [claimId2],
  ));
  await expect(withTenant(f.accountantCtx, (tx) => deleteDraft(tx, f.accountantCtx, claimId2)))
    .rejects.toThrow(/only draft claims can be deleted/i);
});

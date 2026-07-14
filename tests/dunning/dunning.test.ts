import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { setup, issueOpenReceivable } from '../receivables/helpers.js';
import { runDunning } from '../../src/dunning/dunning.js';
import { setDunningPolicy, setStages } from '../../src/dunning/policy.js';
import { listTasks } from '../../src/collab/tasks.js';
import { settleReceivable } from '../../src/receivables/settlement.js';
import { voidReceivable, getReceivable } from '../../src/receivables/receivables.js';

// SAMPLE_INVOICE issueDate is 2026-03-10; issueOpenReceivable defaults dueDate 2026-03-24.
async function overdueClient(dueDate = '2026-03-10') {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId, { dueDate });
  return { cid, customerId, einvoiceId };
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('default stages: an invoice 20 days overdue reaches level 2 and creates one task', async () => {
  const { cid } = await overdueClient('2026-03-10'); // asOf-20d below
  const summary = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' }));
  expect(summary.prompted).toBe(1);
  expect(summary.byLevel).toEqual({ 2: 1 }); // DEFAULT_STAGES: L2 at 15d, L3 at 30d -> 20d = L2
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(1);
  expect(tasks[0]!.title).toMatch(/INV-2026-001/);
});

test('idempotent: a second run at the same asOf creates no new task', async () => {
  const { cid } = await overdueClient('2026-03-10');
  await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' }));
  const summary2 = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' }));
  expect(summary2.prompted).toBe(0);
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(1);
});

test('escalation: a later run at a higher day-count fires the next level once', async () => {
  const { cid } = await overdueClient('2026-03-10');
  await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' })); // L2
  const later = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-04-20' })); // ~41d -> L3
  expect(later.byLevel).toEqual({ 3: 1 });
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(2);
});

test('not-yet-due and paid/void invoices are skipped', async () => {
  const { cid, customerId } = await setup();
  await issueOpenReceivable(cid, customerId, { dueDate: '2026-12-31' }); // future due

  const { einvoiceId: paidId } = await issueOpenReceivable(cid, customerId, { dueDate: '2026-03-10' }); // overdue but paid
  await withTenant(cid, (tx) => settleReceivable(tx, cid, {
    einvoiceId: paidId, amountCents: '12100', paidDate: '2026-03-15',
    method: 'manual', bankAccount: '2620', receivableAccount: '2310',
  }));

  const { einvoiceId: voidId } = await issueOpenReceivable(cid, customerId, { dueDate: '2026-03-10' }); // overdue but voided
  await withTenant(cid, (tx) => voidReceivable(tx, cid, voidId));

  // Sanity-check the fixtures actually landed in the states this test relies on.
  const [paidRow, voidRow] = await withTenant(cid, async (tx) => [
    await getReceivable(tx, cid, paidId),
    await getReceivable(tx, cid, voidId),
  ]);
  expect(paidRow.status).toBe('paid');
  expect(voidRow.status).toBe('void');

  const summary = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-06-30' }));
  expect(summary.prompted).toBe(0);
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(0);
});

test('enabled=false is a no-op', async () => {
  const { cid } = await overdueClient('2026-03-10');
  await withTenant(cid, (tx) => setDunningPolicy(tx, cid, { enabled: false, lateFeeAnnualBps: 0, lateFeeFlatCents: '0' }));
  const summary = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' }));
  expect(summary.prompted).toBe(0);
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks).toHaveLength(0);
});

test('custom stages + late fee: task message includes the accrued fee', async () => {
  const { cid } = await overdueClient('2026-03-10');
  await withTenant(cid, (tx) => setStages(tx, cid, [{ level: 1, daysOverdue: 5 }]));
  await withTenant(cid, (tx) => setDunningPolicy(tx, cid, { enabled: true, lateFeeAnnualBps: 0, lateFeeFlatCents: '500' }));
  const summary = await withTenant(cid, (tx) => runDunning(tx, cid, { asOf: '2026-03-30' }));
  expect(summary.byLevel).toEqual({ 1: 1 });
  const tasks = await withTenant(cid, (tx) => listTasks(tx, cid, {}));
  expect(tasks[0]!.detail).toMatch(/5\.00/); // flat 500 cents rendered as 5.00
});

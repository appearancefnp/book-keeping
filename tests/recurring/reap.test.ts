import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker, withSupervisor } from '../../src/db/pool.js';
import { createParty } from '../../src/parties/parties.js';
import { createTemplate } from '../../src/recurring/recurring.js';
import type { RecurringInvoicePayload } from '../../src/recurring/recurring.js';
import { reapRecurring } from '../../src/recurring/reap.js';

const PAYLOAD: RecurringInvoicePayload = {
  currency: 'EUR',
  supplier: { name: 'S', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'C', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'x', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};
const NOW = new Date('2026-05-10T09:00:00Z');

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function makeDueTemplate(t: ReturnType<typeof ctx>, over = {}) {
  return withTenant(t, async (tx) => {
    const { id: customerPartyId } = await createParty(tx, t, { kind: 'customer', name: 'C' });
    return createTemplate(tx, t, {
      customerPartyId, recipientPeppolId: '0088:test', invoicePayload: PAYLOAD,
      anchorDay: 5, intervalMonths: 1, firstRunDate: '2026-05-05', ...over,
    });
  });
}

test('seeds a recurring_generate for an active due template with no live job', async () => {
  const t = ctx(await makeFirmAndClient());
  await makeDueTemplate(t);
  const { seeded } = await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  expect(seeded).toBe(1);
  const jobs = await withWorker((tx) => tx.query(`SELECT type, status FROM jobs`));
  expect(jobs.rows).toEqual([{ type: 'recurring_generate', status: 'pending' }]);
});

test('no-op when a live job already exists', async () => {
  const t = ctx(await makeFirmAndClient());
  await makeDueTemplate(t);
  await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  const { seeded } = await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  expect(seeded).toBe(0);
});

test('no-op for an inactive template', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await makeDueTemplate(t);
  await withTenant(t, (tx) => tx.query(`UPDATE recurring_invoice_templates SET active=false WHERE id=$1`, [id]));
  const { seeded } = await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  expect(seeded).toBe(0);
});

test('revives a dead chain: only a past failed job exists', async () => {
  const t = ctx(await makeFirmAndClient());
  await makeDueTemplate(t);
  await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  await withWorker((tx) => tx.query(`UPDATE jobs SET status='failed', attempts=3, claimed_at=now()`));
  const { seeded } = await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  expect(seeded).toBe(1);
  // Resurrected in place: exactly one row, reset to pending with attempts/claim cleared
  // (proves DO UPDATE fired, not a second INSERT and not left failed).
  const jobs = await withWorker((tx) => tx.query(
    `SELECT status, attempts, claimed_at FROM jobs WHERE type='recurring_generate'`));
  expect(jobs.rows).toEqual([{ status: 'pending', attempts: 0, claimed_at: null }]);
});

test('no-op when the template is not yet due', async () => {
  const t = ctx(await makeFirmAndClient());
  await makeDueTemplate(t, { firstRunDate: '2026-07-05' });
  const { seeded } = await withSupervisor((tx) => reapRecurring(tx, { now: NOW }));
  expect(seeded).toBe(0);
});

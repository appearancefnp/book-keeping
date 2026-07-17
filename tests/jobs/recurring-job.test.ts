import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { setAutonomy } from '../../src/autonomy/autonomy.js';
import { arAging } from '../../src/receivables/aging.js';
import { createTemplate, getTemplate } from '../../src/recurring/recurring.js';
import type { RecurringInvoicePayload } from '../../src/recurring/recurring.js';
import { enqueueRecurringGenerate, periodKey } from '../../src/recurring/schedule.js';
import { utcMidnight } from '../../src/dunning/schedule.js';
import { drainOnce } from '../../src/jobs/worker.js';
import '../../src/jobs/register.js';

const PAYLOAD: RecurringInvoicePayload = {
  currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Abonēšana', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function setup() {
  const t = ctx(await makeFirmAndClient());
  const customerPartyId = await withTenant(t, async (tx) => {
    await createAccount(tx, t, { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, t, { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, t, { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, t, { year: 2026, month: 5 });
    await setAutonomy(tx, t, { operationType: 'recurring_invoice', mode: 'auto' });
    const { id } = await createParty(tx, t, { kind: 'customer', name: 'SIA Klients', paymentTermsDays: 14 });
    return id;
  });
  const { id } = await withTenant(t, (tx) => createTemplate(tx, t, {
    customerPartyId, recipientPeppolId: '0088:test', invoicePayload: PAYLOAD,
    anchorDay: 10, intervalMonths: 1, firstRunDate: '2026-05-10',
  }));
  return { t, templateId: id };
}

test('draining a recurring_generate job creates an open receivable that ages, and perpetuates one successor', async () => {
  const { t, templateId } = await setup();
  await withTenant(t, (tx) => enqueueRecurringGenerate(tx, t, {
    templateId, period: '2026-05', runAt: utcMidnight('2026-05-10'), asOf: '2026-05-10',
  }));

  const { ran, failed } = await drainOnce({ now: new Date('2026-05-10T09:00:00Z'), leaseTimeoutMs: 5 * 60 * 1000, limit: 10 });
  expect({ ran, failed }).toEqual({ ran: 1, failed: 0 });

  const aging = await withTenant(t, (tx) => arAging(tx, t, { asOf: '2026-05-10' }));
  expect(aging.total).toBe('121.00'); // born open, flows into AR aging

  // Exactly one successor job for the advanced period.
  const row = await withTenant(t, (tx) => getTemplate(tx, t, templateId));
  expect(row.nextRunDate).toBe('2026-06-10');
  const pending = await withWorker((tx) => tx.query(`SELECT dedup_key FROM jobs WHERE status='pending'`));
  expect(pending.rows).toEqual([{ dedup_key: 'recurring:' + templateId + ':2026-06' }]);
});

test('an inactive template stops chain perpetuation (no successor)', async () => {
  const { t, templateId } = await setup();
  await withTenant(t, (tx) => tx.query(`UPDATE recurring_invoice_templates SET active=false WHERE id=$1`, [templateId]));
  await withTenant(t, (tx) => enqueueRecurringGenerate(tx, t, {
    templateId, period: '2026-05', runAt: utcMidnight('2026-05-10'), asOf: '2026-05-10',
  }));
  await drainOnce({ now: new Date('2026-05-10T09:00:00Z'), leaseTimeoutMs: 5 * 60 * 1000, limit: 10 });
  const pending = await withWorker((tx) => tx.query(`SELECT count(*)::int AS n FROM jobs WHERE status='pending'`));
  expect(pending.rows[0].n).toBe(0);
});

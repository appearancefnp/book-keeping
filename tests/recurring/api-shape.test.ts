import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant, withWorker } from '../../src/db/pool.js';
import { createParty } from '../../src/parties/parties.js';
import { createTemplate } from '../../src/recurring/recurring.js';
import type { RecurringInvoicePayload } from '../../src/recurring/recurring.js';
import { enqueueRecurringGenerate, periodKey } from '../../src/recurring/schedule.js';
import { utcMidnight } from '../../src/dunning/schedule.js';

const PAYLOAD: RecurringInvoicePayload = {
  currency: 'EUR',
  supplier: { name: 'S', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'C', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'x', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('creating a template and enqueuing its first job (the POST route contract)', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await withTenant(t, async (tx) => {
    const { id: customerPartyId } = await createParty(tx, t, { kind: 'customer', name: 'C' });
    const created = await createTemplate(tx, t, {
      customerPartyId, recipientPeppolId: '0088:test', invoicePayload: PAYLOAD,
      anchorDay: 10, intervalMonths: 1, firstRunDate: '2026-06-10',
    });
    await enqueueRecurringGenerate(tx, t, { templateId: created.id, period: periodKey('2026-06-10'), runAt: utcMidnight('2026-06-10') });
    return created;
  });
  const jobs = await withWorker((tx) => tx.query(`SELECT type, dedup_key FROM jobs`));
  expect(jobs.rows).toEqual([{ type: 'recurring_generate', dedup_key: 'recurring:' + id + ':2026-06' }]);
});

import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createParty } from '../../src/parties/parties.js';
import { createTemplate, getTemplate, listTemplates, updateTemplate, deactivateTemplate } from '../../src/recurring/recurring.js';
import type { RecurringInvoicePayload } from '../../src/recurring/recurring.js';

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

const PAYLOAD: RecurringInvoicePayload = {
  currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Abonēšana', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

async function make(t: ReturnType<typeof ctx>, over: Partial<Parameters<typeof createTemplate>[2]> = {}) {
  return withTenant(t, async (tx) => {
    const { id: customerPartyId } = await createParty(tx, t, { kind: 'customer', name: 'SIA Klients' });
    return createTemplate(tx, t, {
      customerPartyId, recipientPeppolId: '0088:test', invoicePayload: PAYLOAD,
      anchorDay: 1, intervalMonths: 1, firstRunDate: '2026-06-01', ...over,
    });
  });
}

test('createTemplate + getTemplate round-trips fields', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await make(t);
  const row = await withTenant(t, (tx) => getTemplate(tx, t, id));
  expect(row.nextRunDate).toBe('2026-06-01');
  expect(row.intervalMonths).toBe(1);
  expect(row.active).toBe(true);
  expect(row.invoicePayload.grandTotal).toBe('121.00');
  expect(row.occurrencesRemaining).toBeNull();
});

test('listTemplates filters by active', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await make(t);
  await make(t);
  await withTenant(t, (tx) => deactivateTemplate(tx, t, id));
  const active = await withTenant(t, (tx) => listTemplates(tx, t, { active: true }));
  expect(active).toHaveLength(1);
  const all = await withTenant(t, (tx) => listTemplates(tx, t));
  expect(all).toHaveLength(2);
});

test('updateTemplate changes future-run fields', async () => {
  const t = ctx(await makeFirmAndClient());
  const { id } = await make(t);
  await withTenant(t, (tx) => updateTemplate(tx, t, id, { intervalMonths: 3, endDate: '2027-06-01' }));
  const row = await withTenant(t, (tx) => getTemplate(tx, t, id));
  expect(row.intervalMonths).toBe(3);
  expect(row.endDate).toBe('2027-06-01');
});

test('createTemplate rejects a payload whose totals do not reconcile', async () => {
  const t = ctx(await makeFirmAndClient());
  await expect(withTenant(t, async (tx) => {
    const { id: customerPartyId } = await createParty(tx, t, { kind: 'customer', name: 'C' });
    return createTemplate(tx, t, {
      customerPartyId, recipientPeppolId: '0088:test',
      invoicePayload: { ...PAYLOAD, grandTotal: '999.00' },
      anchorDay: 1, intervalMonths: 1, firstRunDate: '2026-06-01',
    });
  })).rejects.toThrow(/BR-CO-15|payload/i);
});

test('createTemplate + getTemplate round-trips a non-standard vatCategory (AE, zero rate)', async () => {
  const t = ctx(await makeFirmAndClient());
  const aePayload: RecurringInvoicePayload = {
    ...PAYLOAD,
    lines: [{ description: 'EU service', net: '100.00', vatRate: 0, vat: '0.00', vatCategory: 'AE' }],
    vatTotal: '0.00', grandTotal: '100.00',
  };
  const { id } = await make(t, { invoicePayload: aePayload });
  const row = await withTenant(t, (tx) => getTemplate(tx, t, id));
  const [line] = row.invoicePayload.lines;
  expect(line?.vatCategory).toBe('AE');
  expect(line?.vatRate).toBe(0);
});

test('createTemplate rejects a payload with no invoice lines', async () => {
  const t = ctx(await makeFirmAndClient());
  await expect(withTenant(t, async (tx) => {
    const { id: customerPartyId } = await createParty(tx, t, { kind: 'customer', name: 'C' });
    return createTemplate(tx, t, {
      customerPartyId, recipientPeppolId: '0088:test',
      invoicePayload: { ...PAYLOAD, lines: [] },
      anchorDay: 1, intervalMonths: 1, firstRunDate: '2026-06-01',
    });
  })).rejects.toThrow(/BR-16|BR-CO-10|payload/i);
});

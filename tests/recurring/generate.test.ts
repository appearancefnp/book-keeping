import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { setAutonomy } from '../../src/autonomy/autonomy.js';
import { listProposals } from '../../src/proposals/proposals.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { createTemplate, getTemplate } from '../../src/recurring/recurring.js';
import type { RecurringInvoicePayload } from '../../src/recurring/recurring.js';
import { generateDueRecurring } from '../../src/recurring/generate.js';

const ACCOUNTS = { receivable: '2310', sales: '6110', vat: '5721' };
const PAYLOAD: RecurringInvoicePayload = {
  currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Abonēšana', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

/** Tenant + accounts + open 2026-05 period + customer party; returns ctx + customerPartyId. */
async function setup(): Promise<{ t: ReturnType<typeof ctx>; customerPartyId: string }> {
  const t = ctx(await makeFirmAndClient());
  const customerPartyId = await withTenant(t, async (tx) => {
    await createAccount(tx, t, { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, t, { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, t, { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, t, { year: 2026, month: 5 });
    const { id } = await createParty(tx, t, { kind: 'customer', name: 'SIA Klients', paymentTermsDays: 14 });
    return id;
  });
  return { t, customerPartyId };
}

async function makeTemplate(t: ReturnType<typeof ctx>, customerPartyId: string, over = {}) {
  return withTenant(t, (tx) => createTemplate(tx, t, {
    customerPartyId, recipientPeppolId: '0088:test', invoicePayload: PAYLOAD,
    anchorDay: 10, intervalMonths: 1, firstRunDate: '2026-05-10', ...over,
  }));
}

test('auto autonomy issues an open receivable and advances next_run_date', async () => {
  const { t, customerPartyId } = await setup();
  await withTenant(t, (tx) => setAutonomy(tx, t, { operationType: 'recurring_invoice', mode: 'auto' }));
  const { id } = await makeTemplate(t, customerPartyId);

  const r = await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-10T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  expect(r).toEqual({ generated: true, active: true });

  const inv = await withTenant(t, (tx) => tx.query(
    `SELECT invoice_number, status, due_date::text AS due FROM einvoices WHERE direction='outbound'`));
  expect(inv.rows[0].status).toBe('open');
  expect(inv.rows[0].invoice_number).toMatch(/^INV-2026-05-/);
  expect(inv.rows[0].due).toBe('2026-05-24'); // issue 05-10 + 14 terms
  const row = await withTenant(t, (tx) => getTemplate(tx, t, id));
  expect(row.nextRunDate).toBe('2026-06-10');
});

test('approval autonomy creates a pending_approval proposal and NO einvoice', async () => {
  const { t, customerPartyId } = await setup();
  // no autonomy policy → default-closed → approval
  const { id } = await makeTemplate(t, customerPartyId);
  const r = await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-10T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  expect(r.generated).toBe(true);
  const held = await withTenant(t, (tx) => listProposals(tx, t, { status: 'pending_approval' }));
  expect(held.map((p) => p.type)).toEqual(['recurring_invoice']);
  const inv = await withTenant(t, (tx) => tx.query(`SELECT count(*)::int AS n FROM einvoices`));
  expect(inv.rows[0].n).toBe(0);
});

test('skip-to-current: a back-dated template bills the latest occurrence once', async () => {
  const { t, customerPartyId } = await setup();
  await withTenant(t, (tx) => setAutonomy(tx, t, { operationType: 'recurring_invoice', mode: 'auto' }));
  await withTenant(t, async (tx) => { await openPeriod(tx, t, { year: 2026, month: 1 }); });
  const { id } = await makeTemplate(t, customerPartyId, { firstRunDate: '2026-01-10' });

  const r = await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-15T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  expect(r.generated).toBe(true);
  const inv = await withTenant(t, (tx) => tx.query(`SELECT invoice_number, count(*) OVER () AS n FROM einvoices`));
  expect(inv.rowCount).toBe(1);                       // exactly one invoice, not five
  expect(inv.rows[0].invoice_number).toMatch(/^INV-2026-05-/); // current period, not January
  const row = await withTenant(t, (tx) => getTemplate(tx, t, id));
  expect(row.nextRunDate).toBe('2026-06-10');
});

test('not-yet-due template is a no-op that stays active', async () => {
  const { t, customerPartyId } = await setup();
  await withTenant(t, (tx) => setAutonomy(tx, t, { operationType: 'recurring_invoice', mode: 'auto' }));
  const { id } = await makeTemplate(t, customerPartyId, { firstRunDate: '2026-07-10' });
  const r = await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-10T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  expect(r).toEqual({ generated: false, active: true });
  const inv = await withTenant(t, (tx) => tx.query(`SELECT count(*)::int AS n FROM einvoices`));
  expect(inv.rows[0].n).toBe(0);
});

test('occurrences_remaining=1 generates once then deactivates', async () => {
  const { t, customerPartyId } = await setup();
  await withTenant(t, (tx) => setAutonomy(tx, t, { operationType: 'recurring_invoice', mode: 'auto' }));
  const { id } = await makeTemplate(t, customerPartyId, { occurrencesRemaining: 1 });
  const r = await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-10T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  expect(r).toEqual({ generated: true, active: false });
  const row = await withTenant(t, (tx) => getTemplate(tx, t, id));
  expect(row.active).toBe(false);
  expect(row.occurrencesRemaining).toBe(0);
});

test('inactive template is a no-op', async () => {
  const { t, customerPartyId } = await setup();
  const { id } = await makeTemplate(t, customerPartyId);
  await withTenant(t, (tx) => tx.query(`UPDATE recurring_invoice_templates SET active=false WHERE id=$1`, [id]));
  const r = await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-10T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  expect(r).toEqual({ generated: false, active: false });
});

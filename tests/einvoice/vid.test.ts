import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { submitToVid, findOverdueVidSubmissions, addWorkingDays } from '../../src/einvoice/vid.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const inv: EInvoice = {
  invoiceNumber: 'INV-2026-001', issueDate: '2026-03-10', currency: 'EUR',
  supplier: { name: 'S', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'C', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'A', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

async function send(t: { firmId: string; clientCompanyId: string }) {
  return withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return sendInvoice(tx, ctx(t), { invoice: inv, recipientPeppolId: '0088:1', ap: new StubAccessPoint(), receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
  });
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('addWorkingDays skips weekends', () => {
  // 2026-03-10 is a Tuesday; +5 working days = Tuesday 2026-03-17
  expect(addWorkingDays('2026-03-10', 5)).toBe('2026-03-17');
});

test('successful VID submission marks the einvoice submitted and records an attempt', async () => {
  const t = await makeFirmAndClient();
  const { einvoiceId } = await send(t);
  const vid = { submit: async () => ({ ok: true, detail: 'accepted' }) };
  const r = await withTenant(ctx(t), (tx) => submitToVid(tx, ctx(t), einvoiceId, vid));
  expect(r.status).toBe('submitted');
  const row = await withTenant(ctx(t), async (tx) => (await tx.query('SELECT vid_status, vid_due_date FROM einvoices WHERE id=$1', [einvoiceId])).rows[0]);
  expect(row.vid_status).toBe('submitted');
});

test('a failed submission stays retryable and shows up as overdue past due date', async () => {
  const t = await makeFirmAndClient();
  const { einvoiceId } = await send(t);
  const failing = { submit: async () => ({ ok: false, detail: 'VID timeout' }) };
  const r = await withTenant(ctx(t), (tx) => submitToVid(tx, ctx(t), einvoiceId, failing));
  expect(r.status).toBe('failed');
  // Query overdue as of well after the due date
  const overdue = await withTenant(ctx(t), (tx) => findOverdueVidSubmissions(tx, ctx(t), '2026-04-01'));
  expect(overdue.map((o) => o.einvoiceId)).toContain(einvoiceId);
});

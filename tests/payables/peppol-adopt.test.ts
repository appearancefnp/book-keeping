import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { buildUblInvoice } from '../../src/einvoice/ubl.js';
import { receiveInboundInvoices } from '../../src/einvoice/inbound.js';
import { listBills } from '../../src/payables/bills.js';

const TEMPLATE = { expenseAccount: '7710', vatInputAccount: '5721', payablesAccount: '5310' };
const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('inbound Peppol invoice creates a bill (source=peppol) + proposal', async () => {
  const t = await makeFirmAndClient();
  const ubl = buildUblInvoice({
    invoiceNumber: 'S-1', issueDate: '2026-03-05', currency: 'EUR',
    supplier: { name: 'Vendor Oy', regNo: 'FI123', vatNo: 'FI123456789' },
    customer: { name: 'Us', regNo: 'LV1', vatNo: 'LV12345678901' },
    lines: [{ description: 'Parts', net: '100.00', vatRate: 21, vat: '21.00' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  });
  // StubAccessPoint.receive() drains the inbox passed to the constructor (send() only
  // populates .sent, an outbound-message log) — seed the inbox directly here.
  const ap = new StubAccessPoint([{ ublXml: ubl }]);

  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'VAT input', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
  });

  const res = await withTenant(ctx(t), (tx) =>
    receiveInboundInvoices(tx, ctx(t), { ap, template: TEMPLATE, accounts: ACCTS, dueDays: 30 }));
  expect(res.billIds).toHaveLength(1);
  expect(res.proposalIds).toHaveLength(1);

  const bills = await withTenant(ctx(t), (tx) => listBills(tx, ctx(t)));
  expect(bills).toHaveLength(1);
  expect(bills[0]!.source).toBe('peppol');
  expect(bills[0]!.vendorName).toBe('Vendor Oy');
  expect(bills[0]!.grandTotalCents).toBe('12100');
  expect(bills[0]!.dueDate).toBe('2026-04-04'); // 2026-03-05 + 30 days
});

test('second invoice from the same vendor reuses the existing party', async () => {
  const t = await makeFirmAndClient();
  const supplier = { name: 'Repeat Vendor', regNo: 'FI999', vatNo: 'FI999888777' };
  const customer = { name: 'Us', regNo: 'LV1', vatNo: 'LV12345678901' };
  const ubl1 = buildUblInvoice({
    invoiceNumber: 'S-10', issueDate: '2026-03-05', currency: 'EUR', supplier, customer,
    lines: [{ description: 'Parts', net: '100.00', vatRate: 21, vat: '21.00' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  });
  const ubl2 = buildUblInvoice({
    invoiceNumber: 'S-11', issueDate: '2026-03-06', currency: 'EUR', supplier, customer,
    lines: [{ description: 'More parts', net: '50.00', vatRate: 21, vat: '10.50' }],
    netTotal: '50.00', vatTotal: '10.50', grandTotal: '60.50',
  });

  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'VAT input', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
  });

  const ap1 = new StubAccessPoint([{ ublXml: ubl1 }]);
  await withTenant(ctx(t), (tx) => receiveInboundInvoices(tx, ctx(t), { ap: ap1, template: TEMPLATE, accounts: ACCTS }));

  const ap2 = new StubAccessPoint([{ ublXml: ubl2 }]);
  await withTenant(ctx(t), (tx) => receiveInboundInvoices(tx, ctx(t), { ap: ap2, template: TEMPLATE, accounts: ACCTS }));

  const bills = await withTenant(ctx(t), (tx) => listBills(tx, ctx(t)));
  expect(bills).toHaveLength(2);
  expect(new Set(bills.map((b) => b.vendorPartyId)).size).toBe(1); // same vendor party reused
});

test('no inbound invoices yields no bills', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint([]);
  const res = await withTenant(ctx(t), (tx) => receiveInboundInvoices(tx, ctx(t), { ap, template: TEMPLATE, accounts: ACCTS }));
  expect(res.billIds).toHaveLength(0);
  expect(res.proposalIds).toHaveLength(0);
});

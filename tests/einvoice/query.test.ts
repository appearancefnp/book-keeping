import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { listEinvoices } from '../../src/einvoice/query.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const inv: EInvoice = {
  invoiceNumber: 'INV-2026-042', issueDate: '2026-03-10', currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function issueOne(t: { firmId: string; clientCompanyId: string }) {
  const ap = new StubAccessPoint();
  return withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return sendInvoice(tx, ctx(t), {
      invoice: inv, recipientPeppolId: '0088:123', ap,
      receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
    });
  });
}

test('lists outbound einvoices with statuses', async () => {
  const t = await makeFirmAndClient();
  await issueOne(t);
  const rows = await withTenant(ctx(t), (tx) => listEinvoices(tx, ctx(t), { direction: 'outbound' }));
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.invoiceNumber).toBe('INV-2026-042');
  expect(row.issueDate).toBe('2026-03-10');
  expect(row.grandTotalCents).toBe('12100');
  expect(row.peppolStatus).toBe('sent');
  expect(row.vidStatus).toBe('pending');
  expect(row.direction).toBe('outbound');
});

test('does not leak other tenants and respects limit', async () => {
  const t1 = await makeFirmAndClient('SIA Viens');
  const t2 = await makeFirmAndClient('SIA Divi');
  await issueOne(t1);
  const rowsT2 = await withTenant(ctx(t2), (tx) => listEinvoices(tx, ctx(t2)));
  expect(rowsT2).toHaveLength(0);
  const limited = await withTenant(ctx(t1), (tx) => listEinvoices(tx, ctx(t1), { limit: 0 }));
  expect(limited).toHaveLength(0);
});

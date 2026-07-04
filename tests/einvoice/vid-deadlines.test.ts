import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { upcomingVidDeadlines, addWorkingDays } from '../../src/einvoice/vid.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

function inv(number: string, issueDate: string): EInvoice {
  return {
    invoiceNumber: number, issueDate, currency: 'EUR',
    supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
    customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
    lines: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  };
}

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('reports pending outbound invoices with due date and overdue flag', async () => {
  const t = await makeFirmAndClient();
  const ap = new StubAccessPoint();
  await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await sendInvoice(tx, ctx(t), { invoice: inv('INV-1', '2026-03-02'), recipientPeppolId: '0088:1', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
    await sendInvoice(tx, ctx(t), { invoice: inv('INV-2', '2026-03-30'), recipientPeppolId: '0088:1', ap, receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' });
  });
  // asOf 2026-03-31: INV-1 (issued 02.03, due 09.03) overdue; INV-2 (issued 30.03) not yet.
  const deadlines = await withTenant(ctx(t), (tx) => upcomingVidDeadlines(tx, ctx(t), '2026-03-31'));
  expect(deadlines).toHaveLength(2);
  const first = deadlines.find((d) => d.invoiceNumber === 'INV-1')!;
  expect(first.dueDate).toBe(addWorkingDays('2026-03-02', 5));
  expect(first.overdue).toBe(true);
  const second = deadlines.find((d) => d.invoiceNumber === 'INV-2')!;
  expect(second.overdue).toBe(false);
});

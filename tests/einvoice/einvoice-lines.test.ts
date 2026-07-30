import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { sendInvoice, sendCreditNote } from '../../src/einvoice/outbound.js';
import { listEinvoiceLines } from '../../src/einvoice/lines.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const accounts = { receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' };

const invoice: EInvoice = {
  invoiceNumber: 'INV-100', issueDate: '2026-06-15', currency: 'EUR',
  supplier: { name: 'SIA A', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'OU B', regNo: '11111111', vatNo: 'EE101010101' },
  lines: [
    { description: 'Goods to EE', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' },
    { description: 'Domestic', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' },
  ],
  netTotal: '600.00', vatTotal: '21.00', grandTotal: '621.00',
};

async function seed(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    for (const [code, name, type] of [
      ['2310', 'Receivables', 'asset'], ['6110', 'Sales', 'income'], ['5721', 'Output VAT', 'liability'],
    ] as const) await createAccount(tx, ctx(t), { code, name, type });
    await openPeriod(tx, ctx(t), { year: 2026, month: 6 });
  });
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('sendInvoice persists one categorised line row per invoice line', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const { einvoiceId } = await withTenant(ctx(t), (tx) =>
    sendInvoice(tx, ctx(t), { invoice, recipientPeppolId: '0088:ee', ap: new StubAccessPoint(), ...accounts }));

  const lines = await withTenant(ctx(t), (tx) => listEinvoiceLines(tx, ctx(t), einvoiceId));
  expect(lines.map((l) => [l.lineNo, l.vatCategory, l.netCents, l.vatCents]))
    .toEqual([[1, 'K', '50000', '0'], [2, 'S', '10000', '2100']]);
});

test('a line with no explicit category persists as standard rate', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const plain: EInvoice = {
    ...invoice, invoiceNumber: 'INV-101',
    lines: [{ description: 'X', net: '100.00', vatRate: 21, vat: '21.00' }],
    netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
  };
  const { einvoiceId } = await withTenant(ctx(t), (tx) =>
    sendInvoice(tx, ctx(t), { invoice: plain, recipientPeppolId: '0088:ee', ap: new StubAccessPoint(), ...accounts }));
  const lines = await withTenant(ctx(t), (tx) => listEinvoiceLines(tx, ctx(t), einvoiceId));
  expect(lines[0]!.vatCategory).toBe('S');
});

test('sendCreditNote persists its lines too', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const { einvoiceId } = await withTenant(ctx(t), (tx) =>
    sendCreditNote(tx, ctx(t), {
      creditNote: { ...invoice, invoiceNumber: 'CN-1' },
      recipientPeppolId: '0088:ee', ap: new StubAccessPoint(), ...accounts,
    }));
  const lines = await withTenant(ctx(t), (tx) => listEinvoiceLines(tx, ctx(t), einvoiceId));
  expect(lines.length).toBe(2);
  expect(lines[0]!.vatCategory).toBe('K');
});

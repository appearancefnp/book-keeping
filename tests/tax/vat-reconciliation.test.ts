import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { assembleVatDeclaration, toEdsXml } from '../../src/tax/vat-declaration.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';

const config = { outputVatAccount: '5721', inputVatAccount: '5722' };
const period = { fromDate: '2026-06-01', toDate: '2026-06-30' };

const inv: EInvoice = {
  invoiceNumber: 'R-1', issueDate: '2026-06-10', currency: 'EUR',
  supplier: { name: 'SIA A', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA B', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Domestic', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

async function seed(t: { firmId: string; clientCompanyId: string }) {
  await withTenant(ctx(t), async (tx) => {
    for (const [code, name, type] of [
      ['2310', 'Receivables', 'asset'], ['6110', 'Sales', 'income'],
      ['5721', 'Output VAT', 'liability'], ['5722', 'Input VAT', 'asset'],
    ] as const) await createAccount(tx, ctx(t), { code, name, type });
    await openPeriod(tx, ctx(t), { year: 2026, month: 6 });
  });
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('GL and documents agree when every entry came from a document', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), (tx) => sendInvoice(tx, ctx(t), {
    invoice: inv, recipientPeppolId: '0088:lv', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));
  const d = await withTenant(ctx(t), (tx) => assembleVatDeclaration(tx, ctx(t), { ...period, config }));
  expect(d.outputVat).toBe('21.00');
  expect(d.reconciles).toBe(true);
  expect(d.breakdown.rows.map((r) => r.category)).toEqual(['S']);
});

test('a manual journal entry on a VAT account flags a mismatch without throwing', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), (tx) => postEntry(tx, ctx(t), {
    date: '2026-06-20', memo: 'Manual VAT adjustment', currency: 'EUR',
    lines: [
      { accountCode: '2310', debit: '12.10', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '10.00' },
      { accountCode: '5721', debit: '0', credit: '2.10' },
    ],
  }));
  const d = await withTenant(ctx(t), (tx) => assembleVatDeclaration(tx, ctx(t), { ...period, config }));
  expect(d.outputVat).toBe('2.10');            // the ledger stays authoritative
  expect(d.breakdown.documentOutputVatCents).toBe('0');
  expect(d.reconciles).toBe(false);            // flagged, not thrown
});

test('the EDS XML carries the category breakdown', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), (tx) => sendInvoice(tx, ctx(t), {
    invoice: inv, recipientPeppolId: '0088:lv', ap: new StubAccessPoint(),
    receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721',
  }));
  const d = await withTenant(ctx(t), (tx) => assembleVatDeclaration(tx, ctx(t), { ...period, config }));
  const xml = toEdsXml(d);
  expect(xml).toContain('<CategoryBreakdown>');
  expect(xml).toContain('<Category code="S"');
  expect(xml).toContain('reconciles="true"');
});

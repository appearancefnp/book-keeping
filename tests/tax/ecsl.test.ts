import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { sendInvoice, sendCreditNote } from '../../src/einvoice/outbound.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { ecSalesList, toPvn2Xml } from '../../src/tax/ecsl.js';
import type { EInvoice, ECreditNote } from '../../src/einvoice/ubl.js';

const period = { fromDate: '2026-06-01', toDate: '2026-06-30' };
const salesAccounts = { receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' };

async function seed(t: { firmId: string; clientCompanyId: string }) {
  return withTenant(ctx(t), async (tx) => {
    for (const [code, name, type] of [
      ['2310', 'Receivables', 'asset'], ['6110', 'Sales', 'income'], ['5721', 'Output VAT', 'liability'],
    ] as const) await createAccount(tx, ctx(t), { code, name, type });
    await openPeriod(tx, ctx(t), { year: 2026, month: 6 });
    const ee = await createParty(tx, ctx(t), { kind: 'customer', name: 'OU Eesti', regNo: '11111111', vatNo: 'EE101010101', countryCode: 'EE' });
    const lt = await createParty(tx, ctx(t), { kind: 'customer', name: 'UAB Lietuva', regNo: '22222222', vatNo: 'LT100001', countryCode: 'LT' });
    const noVat = await createParty(tx, ctx(t), { kind: 'customer', name: 'OU NoVat', regNo: '33333333', countryCode: 'EE' });
    return { ee: ee.id, lt: lt.id, noVat: noVat.id };
  });
}

// NOTE: K/AE lines must carry vatRate 0 on the sales side (BR-IC-5 / BR-AE-5 — the customer
// accounts for VAT at their own domestic rate, never transmitted on the invoice); see
// src/tax/categories.ts categoryIssues and tests/tax/categories.test.ts. A nonzero rate here
// makes validateEn16931 reject the document and sendInvoice/sendCreditNote throw.
function inv(number: string, lines: EInvoice['lines'], net: string, vat: string, grand: string): EInvoice {
  return {
    invoiceNumber: number, issueDate: '2026-06-15', currency: 'EUR',
    supplier: { name: 'SIA A', regNo: '40100000000', vatNo: 'LV40100000000' },
    customer: { name: 'C', regNo: '11111111', vatNo: 'EE101010101' },
    lines, netTotal: net, vatTotal: vat, grandTotal: grand,
  };
}

async function issue(t: { firmId: string; clientCompanyId: string }, invoice: EInvoice, customerPartyId: string) {
  return withTenant(ctx(t), (tx) => sendInvoice(tx, ctx(t), {
    invoice, recipientPeppolId: '0088:x', ap: new StubAccessPoint(), ...salesAccounts, customerPartyId,
  }));
}

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('groups intra-EU supplies by counterparty, country, and supply type', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  await issue(t, inv('E-1', [
    { description: 'Goods', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' },
    { description: 'Service', net: '300.00', vatRate: 0, vat: '0.00', vatCategory: 'AE' },
    { description: 'Domestic', net: '100.00', vatRate: 21, vat: '21.00', vatCategory: 'S' },
  ], '900.00', '21.00', '921.00'), p.ee);
  await issue(t, inv('E-2', [
    { description: 'More goods', net: '200.00', vatRate: 0, vat: '0.00', vatCategory: 'K' },
  ], '200.00', '0.00', '200.00'), p.ee);
  await issue(t, inv('E-3', [
    { description: 'LT goods', net: '400.00', vatRate: 0, vat: '0.00', vatCategory: 'K' },
  ], '400.00', '0.00', '400.00'), p.lt);

  const list = await withTenant(ctx(t), (tx) => ecSalesList(tx, ctx(t), period));

  expect(list.rows).toEqual([
    { countryCode: 'EE', vatNo: 'EE101010101', supplyType: 'goods', netCents: '70000', invoiceCount: 2 },
    { countryCode: 'EE', vatNo: 'EE101010101', supplyType: 'services', netCents: '30000', invoiceCount: 1 },
    { countryCode: 'LT', vatNo: 'LT100001', supplyType: 'goods', netCents: '40000', invoiceCount: 1 },
  ]);
  expect(list.totalNetCents).toBe('140000');   // the domestic line is excluded
  expect(list.issues).toEqual([]);
});

test('an outbound credit note against an intra-EU invoice nets against the same counterparty row', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  // Two goods invoices to EE: 500 + 300 = 800.
  await issue(t, inv('E-7', [{ description: 'Goods', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }], '500.00', '0.00', '500.00'), p.ee);
  await issue(t, inv('E-8', [{ description: 'Goods', net: '300.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }], '300.00', '0.00', '300.00'), p.ee);

  // A credit note against E-7 for 200. Its own einvoice row carries no customer_party_id
  // (sendCreditNote never sets one — see src/einvoice/outbound.ts) so it must be resolved
  // through corrected_invoice_number back to E-7's customer, landing in the SAME EE/goods
  // row it is reversing rather than an unlinked, unreportable one of its own.
  const cn: ECreditNote = {
    invoiceNumber: 'CN-1', issueDate: '2026-06-16', currency: 'EUR', correctedInvoiceNumber: 'E-7',
    supplier: { name: 'SIA A', regNo: '40100000000', vatNo: 'LV40100000000' },
    customer: { name: 'C', regNo: '11111111', vatNo: 'EE101010101' },
    lines: [{ description: 'Return', net: '200.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }],
    netTotal: '200.00', vatTotal: '0.00', grandTotal: '200.00',
  };
  await withTenant(ctx(t), (tx) => sendCreditNote(tx, ctx(t), {
    creditNote: cn, recipientPeppolId: '0088:x', ap: new StubAccessPoint(), ...salesAccounts,
  }));

  const list = await withTenant(ctx(t), (tx) => ecSalesList(tx, ctx(t), period));

  // Net: 500 + 300 - 200 = 600 -> 60000 cents. Invoice count: 2 invoices - 1 credit note = 1,
  // the same sign treatment applied to both the amount and the document count.
  expect(list.rows).toEqual([
    { countryCode: 'EE', vatNo: 'EE101010101', supplyType: 'goods', netCents: '60000', invoiceCount: 1 },
  ]);
  expect(list.totalNetCents).toBe('60000');
  expect(list.issues).toEqual([]);
});

test('an intra-EU supply to a party with no VAT number becomes an issue, not a silent drop', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  await issue(t, inv('E-4', [{ description: 'Goods', net: '150.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }], '150.00', '0.00', '150.00'), p.noVat);

  const list = await withTenant(ctx(t), (tx) => ecSalesList(tx, ctx(t), period));
  expect(list.rows).toEqual([]);
  expect(list.issues.length).toBe(1);
  expect(list.issues[0]).toContain('OU NoVat');
  expect(list.issues[0]).toContain('E-4');
});

test('a supply with no linked customer party is reported as an issue', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  await withTenant(ctx(t), (tx) => sendInvoice(tx, ctx(t), {
    invoice: inv('E-5', [{ description: 'Goods', net: '10.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }], '10.00', '0.00', '10.00'),
    recipientPeppolId: '0088:x', ap: new StubAccessPoint(), ...salesAccounts,   // no customerPartyId
  }));
  const list = await withTenant(ctx(t), (tx) => ecSalesList(tx, ctx(t), period));
  expect(list.rows).toEqual([]);
  expect(list.issues.join(' ')).toContain('E-5');
});

test('an empty period yields no rows and no issues', async () => {
  const t = await makeFirmAndClient();
  await seed(t);
  const list = await withTenant(ctx(t), (tx) => ecSalesList(tx, ctx(t), period));
  expect(list).toEqual({ period, rows: [], totalNetCents: '0', issues: [] });
});

test('the PVN 2 XML lists every row with its supply type', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  await issue(t, inv('E-6', [{ description: 'Goods', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }], '500.00', '0.00', '500.00'), p.ee);
  const list = await withTenant(ctx(t), (tx) => ecSalesList(tx, ctx(t), period));
  const xml = toPvn2Xml(list, { vatNo: 'LV40100000000' });
  expect(xml).toContain('<EcSalesList>');
  expect(xml).toContain('<DeclarantVatNo>LV40100000000</DeclarantVatNo>');
  expect(xml).toContain('<Row country="EE" vatNo="EE101010101" supplyType="goods" net="500.00"/>');
  expect(xml).toContain('<TotalNet>500.00</TotalNet>');
});

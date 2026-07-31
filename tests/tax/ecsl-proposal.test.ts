import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { sendInvoice } from '../../src/einvoice/outbound.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import type { EInvoice } from '../../src/einvoice/ubl.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { listMaterialApprovals } from '../../src/proposals/material.js';
import { createEcslProposal } from '../../src/tax/ecsl-proposal.js';

const salesAccounts = { receivableAccount: '2310', salesAccount: '6110', vatAccount: '5721' };

// Copied from tests/tax/ecsl.test.ts — do not export test helpers across files.
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

test('creates a pending-approval ecsl proposal carrying the PVN 2 XML', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  await issue(t, inv('P-1', [{ description: 'Goods', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }], '500.00', '0.00', '500.00'), p.ee);

  const { proposalId, list } = await withTenant(ctx(t), (tx) =>
    createEcslProposal(tx, ctx(t), { fromDate: '2026-06-01', toDate: '2026-06-30' }));

  expect(list.rows.length).toBe(1);
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect(prop.type).toBe('ecsl');
  expect(prop.status).toBe('pending_approval');
  expect(String((prop.rationale as { xml?: string }).xml)).toContain('<EcSalesList>');
});

test('an ecsl proposal is always material for the owner view', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  await issue(t, inv('P-2', [{ description: 'Goods', net: '500.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }], '500.00', '0.00', '500.00'), p.ee);
  await withTenant(ctx(t), (tx) => createEcslProposal(tx, ctx(t), { fromDate: '2026-06-01', toDate: '2026-06-30' }));
  const material = await withTenant(ctx(t), (tx) => listMaterialApprovals(tx, ctx(t)));
  expect(material.map((m) => m.type)).toContain('ecsl');
});

test('unreportable supplies ride along on the proposal rationale', async () => {
  const t = await makeFirmAndClient();
  const p = await seed(t);
  await issue(t, inv('P-3', [{ description: 'Goods', net: '150.00', vatRate: 0, vat: '0.00', vatCategory: 'K' }], '150.00', '0.00', '150.00'), p.noVat);
  const { proposalId, list } = await withTenant(ctx(t), (tx) =>
    createEcslProposal(tx, ctx(t), { fromDate: '2026-06-01', toDate: '2026-06-30' }));
  expect(list.issues.length).toBe(1);
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect(JSON.stringify(prop.rationale)).toContain('no counterparty VAT number');
});

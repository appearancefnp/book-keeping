import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { createBill, listBills, getBill, voidBill, buildBillEntry } from '../../src/payables/bills.js';

const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seed() {
  const t = await makeFirmAndClient();
  const vendor = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'VAT input', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    return createParty(tx, ctx(t), { kind: 'vendor', name: 'Acme Supplies', iban: 'LV80BANK0000435195001' });
  });
  return { t, vendorId: vendor.id };
}

const sampleBill = (vendorPartyId: string) => ({
  vendorPartyId, billNumber: 'INV-42', issueDate: '2026-03-10', dueDate: '2026-04-09', currency: 'EUR',
  lines: [
    { description: 'Widgets', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '21.00' },
    { description: 'Freight', expenseAccount: '7710', net: '50.00', vatRate: 21, vat: '10.50' },
  ],
});

test('buildBillEntry produces a balanced per-line payable entry', () => {
  const entry = buildBillEntry(sampleBill('v'), ACCTS);
  // 2 expense debits + 1 VAT debit + 1 payables credit
  expect(entry.lines).toHaveLength(4);
  const debit = entry.lines.reduce((a, l) => a + Number(l.debit), 0);
  const credit = entry.lines.reduce((a, l) => a + Number(l.credit), 0);
  expect(debit).toBeCloseTo(181.5);
  expect(credit).toBeCloseTo(181.5);
  const payable = entry.lines.find((l) => l.accountCode === '5310')!;
  expect(payable.credit).toBe('181.50');
});

test('createBill writes bill, lines, and a pending posting proposal', async () => {
  const { t, vendorId } = await seed();
  const { billId, proposalId } = await withTenant(ctx(t), (tx) => createBill(tx, ctx(t), sampleBill(vendorId), ACCTS));
  const detail = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(detail.status).toBe('awaiting_approval');
  expect(detail.grandTotalCents).toBe('18150');
  expect(detail.outstandingCents).toBe('18150');
  expect(detail.vendorName).toBe('Acme Supplies');
  expect(detail.lines).toHaveLength(2);
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect(prop.type).toBe('posting');
  expect(prop.status).toBe('pending_approval');
});

test('listBills returns rows with outstanding and filters by status', async () => {
  const { t, vendorId } = await seed();
  await withTenant(ctx(t), (tx) => createBill(tx, ctx(t), sampleBill(vendorId), ACCTS));
  const all = await withTenant(ctx(t), (tx) => listBills(tx, ctx(t)));
  expect(all).toHaveLength(1);
  expect(all[0]!.outstandingCents).toBe('18150');
  const open = await withTenant(ctx(t), (tx) => listBills(tx, ctx(t), { status: 'open' }));
  expect(open).toHaveLength(0);
});

test('createBill rejects a line with negative net (credit notes are out of scope for M2)', async () => {
  const { t, vendorId } = await seed();
  const bill = {
    ...sampleBill(vendorId),
    lines: [{ description: 'Refund', expenseAccount: '7710', net: '-100.00', vatRate: 21, vat: '-21.00' }],
  };
  await expect(withTenant(ctx(t), (tx) => createBill(tx, ctx(t), bill, ACCTS)))
    .rejects.toThrow(/negative|credit note/i);
  const bills = await withTenant(ctx(t), (tx) => listBills(tx, ctx(t)));
  expect(bills).toHaveLength(0);
});

test('voidBill voids an awaiting_approval bill and rejects its proposal', async () => {
  const { t, vendorId } = await seed();
  const { billId, proposalId } = await withTenant(ctx(t), (tx) => createBill(tx, ctx(t), sampleBill(vendorId), ACCTS));
  await withTenant(ctx(t), (tx) => voidBill(tx, ctx(t), billId));
  const detail = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(detail.status).toBe('void');
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect(prop.status).toBe('rejected');
});

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { approveProposal } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';
import { createBill, getBill, voidBill } from '../../src/payables/bills.js';
import { settleBill } from '../../src/payables/settlement.js';

const ACCTS = { vatInputAccount: '5721', payablesAccount: '5310' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function openBill(net = '100.00', vat = '21.00') {
  const t = await makeFirmAndClient();
  const { billId } = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'VAT input', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '2699', name: 'In transit', type: 'asset' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    const v = await createParty(tx, ctx(t), { kind: 'vendor', name: 'Acme', iban: 'LV80B0000435195001' });
    const b = await createBill(tx, ctx(t), {
      vendorPartyId: v.id, billNumber: 'B-1', issueDate: '2026-03-01', dueDate: '2026-03-31', currency: 'EUR',
      lines: [{ description: 'x', expenseAccount: '7710', net, vatRate: 21, vat }],
    }, ACCTS);
    await approveProposal(tx, ctx(t), b.proposalId);
    await postApprovedPosting(tx, ctx(t), b.proposalId);
    return b;
  });
  return { t, billId };
}

test('full settlement marks the bill paid', async () => {
  const { t, billId } = await openBill(); // grand = 121.00 -> 12100c
  await withTenant(ctx(t), (tx) => settleBill(tx, ctx(t), {
    billId, amountCents: '12100', paidDate: '2026-03-15', method: 'bank_match',
    payablesAccount: '5310', creditAccount: '2620',
  }));
  const b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(b.status).toBe('paid');
  expect(b.outstandingCents).toBe('0');
});

test('partial settlement marks the bill partially_paid; a second completes it', async () => {
  const { t, billId } = await openBill();
  await withTenant(ctx(t), (tx) => settleBill(tx, ctx(t), {
    billId, amountCents: '5000', paidDate: '2026-03-15', method: 'manual', payablesAccount: '5310', creditAccount: '2620',
  }));
  let b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(b.status).toBe('partially_paid');
  expect(b.outstandingCents).toBe('7100');
  await withTenant(ctx(t), (tx) => settleBill(tx, ctx(t), {
    billId, amountCents: '7100', paidDate: '2026-03-20', method: 'manual', payablesAccount: '5310', creditAccount: '2620',
  }));
  b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(b.status).toBe('paid');
});

test('over-payment is rejected', async () => {
  const { t, billId } = await openBill();
  await expect(withTenant(ctx(t), (tx) => settleBill(tx, ctx(t), {
    billId, amountCents: '99999', paidDate: '2026-03-15', method: 'manual', payablesAccount: '5310', creditAccount: '2620',
  }))).rejects.toThrow(/outstanding/i);
});

test('settling a void bill is rejected', async () => {
  const t = await makeFirmAndClient();
  const billId = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '7710', name: 'Expenses', type: 'expense' });
    await createAccount(tx, ctx(t), { code: '5721', name: 'VAT input', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '5310', name: 'Payables', type: 'liability' });
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    const v = await createParty(tx, ctx(t), { kind: 'vendor', name: 'Acme', iban: 'LV80B0000435195001' });
    const b = await createBill(tx, ctx(t), {
      vendorPartyId: v.id, billNumber: 'B-VOID', issueDate: '2026-03-01', dueDate: '2026-03-31', currency: 'EUR',
      lines: [{ description: 'x', expenseAccount: '7710', net: '100.00', vatRate: 21, vat: '21.00' }],
    }, ACCTS);
    await voidBill(tx, ctx(t), b.billId);
    return b.billId;
  });
  const b = await withTenant(ctx(t), (tx) => getBill(tx, ctx(t), billId));
  expect(b.status).toBe('void');
  await expect(withTenant(ctx(t), (tx) => settleBill(tx, ctx(t), {
    billId, amountCents: '100', paidDate: '2026-03-15', method: 'manual', payablesAccount: '5310', creditAccount: '2620',
  }))).rejects.toThrow(/settleable|status/i);
});

test('non-positive amounts are rejected', async () => {
  const { t, billId } = await openBill();
  for (const amountCents of ['0', '-100']) {
    await expect(withTenant(ctx(t), (tx) => settleBill(tx, ctx(t), {
      billId, amountCents, paidDate: '2026-03-15', method: 'manual', payablesAccount: '5310', creditAccount: '2620',
    }))).rejects.toThrow(/positive/i);
  }
});

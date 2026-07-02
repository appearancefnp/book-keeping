import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { postEntry } from '../../src/ledger/posting.js';
import { importStatement } from '../../src/banking/import.js';
import { proposeMatches } from '../../src/banking/match.js';
import { getProposal } from '../../src/proposals/proposals.js';

const config = { receivablesAccount: '2310', bankAccount: '2620' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('proposes a bank_match for a credit that matches an open receivable', async () => {
  const t = await makeFirmAndClient();
  const proposalIds = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, ctx(t), { code: '2620', name: 'Bank', type: 'asset' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    // Credit sale creating a 121.00 receivable
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Credit sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '121.00' },
    ]});
    await importStatement(tx, ctx(t), { account: 'LV80', transactions: [
      { bookingDate: '2026-03-10', amountCents: '12100', currency: 'EUR', side: 'credit', reference: 'pmt', counterparty: 'SIA Klients', endToEndId: 'E1' },
    ]});
    return (await proposeMatches(tx, ctx(t), config)).proposalIds;
  });
  expect(proposalIds).toHaveLength(1);
  const p = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalIds[0]!));
  expect(p.type).toBe('bank_match');
  expect(p.status).toBe('pending_approval');
  expect((p.payload as { amountCents: string }).amountCents).toBe('12100');
  expect((p.rationale as { sourceRefs: { confidence: number } }).sourceRefs.confidence).toBe(1.0);
});

test('does not propose when no receivable matches the amount', async () => {
  const t = await makeFirmAndClient();
  const ids = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    await postEntry(tx, ctx(t), { date: '2026-03-05', memo: 'Credit sale', currency: 'EUR', lines: [
      { accountCode: '2310', debit: '121.00', credit: '0' },
      { accountCode: '6110', debit: '0', credit: '121.00' },
    ]});
    await importStatement(tx, ctx(t), { account: 'LV80', transactions: [
      { bookingDate: '2026-03-10', amountCents: '9999', currency: 'EUR', side: 'credit', reference: 'x', counterparty: 'y', endToEndId: 'E2' },
    ]});
    return (await proposeMatches(tx, ctx(t), config)).proposalIds;
  });
  expect(ids).toHaveLength(0);
});

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { importStatement } from '../../src/banking/import.js';
import { proposeArMatches } from '../../src/banking/match.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { setup, issueOpenReceivable } from '../receivables/helpers.js';
import type { TenantContext } from '../../src/tenancy/context.js';

const config = { receivableAccount: '2310', bankAccount: '2620' };

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function importCreditTxn(cid: TenantContext, amountCents: string, endToEndId: string): Promise<void> {
  await withTenant(cid, (tx) => importStatement(tx, cid, {
    account: 'LV80',
    transactions: [
      { bookingDate: '2026-03-20', amountCents, currency: 'EUR', side: 'credit', reference: 'pmt', counterparty: 'SIA Klients', endToEndId },
    ],
  }));
}

test('proposes an invoice-linked bank_match for a credit equal to an open receivable', async () => {
  const { cid, customerId } = await setup();
  const { einvoiceId } = await issueOpenReceivable(cid, customerId); // grand 12100
  await importCreditTxn(cid, '12100', 'e2e-1'); // one unmatched credit of 121.00
  const ids = await withTenant(cid, (tx) => proposeArMatches(tx, cid, config).then((r) => r.proposalIds));
  expect(ids).toHaveLength(1);
  const prop = await withTenant(cid, (tx) => getProposal(tx, cid, ids[0]!));
  expect(prop.type).toBe('bank_match');
  expect((prop.payload as any).kind).toBe('receivable_direct');
  expect((prop.payload as any).einvoiceId).toBe(einvoiceId);
});

test('does not propose when no open receivable matches the amount', async () => {
  const { cid, customerId } = await setup();
  await issueOpenReceivable(cid, customerId); // 12100
  await importCreditTxn(cid, '9999', 'e2e-2');
  const ids = await withTenant(cid, (tx) => proposeArMatches(tx, cid, config).then((r) => r.proposalIds));
  expect(ids).toHaveLength(0);
});

test('does not double-claim one receivable for two equal credits', async () => {
  const { cid, customerId } = await setup();
  await issueOpenReceivable(cid, customerId); // single 12100 receivable
  await importCreditTxn(cid, '12100', 'e2e-3');
  await importCreditTxn(cid, '12100', 'e2e-4');
  const ids = await withTenant(cid, (tx) => proposeArMatches(tx, cid, config).then((r) => r.proposalIds));
  expect(ids).toHaveLength(1);
});

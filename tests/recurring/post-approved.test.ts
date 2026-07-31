import { afterAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod, closePeriod } from '../../src/ledger/periods.js';
import { createParty } from '../../src/parties/parties.js';
import { listProposals, getProposal } from '../../src/proposals/proposals.js';
import { approveProposal, rejectProposal } from '../../src/proposals/lifecycle.js';
import { StubAccessPoint } from '../../src/einvoice/access-point.js';
import { createTemplate } from '../../src/recurring/recurring.js';
import type { RecurringInvoicePayload } from '../../src/recurring/recurring.js';
import { generateDueRecurring } from '../../src/recurring/generate.js';
import { postApprovedRecurringInvoice } from '../../src/recurring/post-approved.js';

const ACCOUNTS = { receivable: '2310', sales: '6110', vat: '5721' };
const PAYLOAD: RecurringInvoicePayload = {
  currency: 'EUR',
  supplier: { name: 'SIA Pārdevējs', regNo: '40100000000', vatNo: 'LV40100000000' },
  customer: { name: 'SIA Klients', regNo: '40200000000', vatNo: 'LV40200000000' },
  lines: [{ description: 'Abonēšana', net: '100.00', vatRate: 21, vat: '21.00' }],
  netTotal: '100.00', vatTotal: '21.00', grandTotal: '121.00',
};

beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

/** Tenant + accounts + open 2026-05 period + customer party. */
async function setup() {
  const t = ctx(await makeFirmAndClient());
  const customerPartyId = await withTenant(t, async (tx) => {
    await createAccount(tx, t, { code: '2310', name: 'Debtors', type: 'asset' });
    await createAccount(tx, t, { code: '6110', name: 'Sales', type: 'income' });
    await createAccount(tx, t, { code: '5721', name: 'Output VAT', type: 'liability' });
    await openPeriod(tx, t, { year: 2026, month: 5 });
    const { id } = await createParty(tx, t, { kind: 'customer', name: 'SIA Klients', paymentTermsDays: 14 });
    return id;
  });
  return { t, customerPartyId };
}

/**
 * Runs a due template with NO autonomy policy set. resolveAutonomy is default-closed, so this is
 * the approval branch — the one every client gets out of the box — and yields a pending proposal.
 */
async function generatePendingProposal(t: ReturnType<typeof ctx>, customerPartyId: string) {
  const { id } = await withTenant(t, (tx) => createTemplate(tx, t, {
    customerPartyId, recipientPeppolId: '0088:test', invoicePayload: PAYLOAD,
    anchorDay: 10, intervalMonths: 1, firstRunDate: '2026-05-10',
  }));
  await withTenant(t, (tx) => generateDueRecurring(tx, t, {
    templateId: id, now: new Date('2026-05-10T09:00:00Z'), ap: new StubAccessPoint(), accounts: ACCOUNTS,
  }));
  const [proposal] = await withTenant(t, (tx) => listProposals(tx, t, { status: 'pending_approval' }));
  expect(proposal!.type).toBe('recurring_invoice');
  return { templateId: id, proposalId: proposal!.id };
}

test('approving a recurring invoice issues it, posts the receivable, records the message id', async () => {
  const { t, customerPartyId } = await setup();
  const { proposalId } = await generatePendingProposal(t, customerPartyId);
  const ap = new StubAccessPoint();

  const { entryId } = await withTenant(t, async (tx) => {
    await approveProposal(tx, t, proposalId);
    return postApprovedRecurringInvoice(tx, t, proposalId, { ap });
  });

  expect(entryId).toBeTruthy();
  expect(ap.sent).toHaveLength(1);
  expect(ap.sent[0]!.recipient).toBe('0088:test');

  const inv = await withTenant(t, (tx) => tx.query(
    `SELECT invoice_number, status, peppol_message_id, journal_entry_id, due_date::text AS due
       FROM einvoices WHERE direction = 'outbound'`));
  expect(inv.rowCount).toBe(1);
  expect(inv.rows[0].invoice_number).toMatch(/^INV-2026-05-/);
  expect(inv.rows[0].status).toBe('open');
  expect(inv.rows[0].peppol_message_id).toBe('stub-msg-1');
  expect(inv.rows[0].journal_entry_id).toBe(entryId);
  expect(inv.rows[0].due).toBe('2026-05-24'); // issue 2026-05-10 + the party's 14-day terms

  const prop = await withTenant(t, (tx) => getProposal(tx, t, proposalId));
  expect(prop.status).toBe('posted');
  expect(prop.resolvedEntryId).toBe(entryId);
});

test('rejecting a recurring invoice issues nothing', async () => {
  const { t, customerPartyId } = await setup();
  const { proposalId } = await generatePendingProposal(t, customerPartyId);

  await withTenant(t, (tx) => rejectProposal(tx, t, proposalId, 'customer cancelled'));

  const inv = await withTenant(t, (tx) => tx.query(
    `SELECT id FROM einvoices WHERE direction = 'outbound'`));
  expect(inv.rowCount).toBe(0);
});

test('posting a proposal that is not approved throws', async () => {
  const { t, customerPartyId } = await setup();
  const { proposalId } = await generatePendingProposal(t, customerPartyId);

  await expect(withTenant(t, (tx) =>
    postApprovedRecurringInvoice(tx, t, proposalId, { ap: new StubAccessPoint() }),
  )).rejects.toThrow(/must be approved/);
});

test('posting a proposal of the wrong type throws', async () => {
  const { t } = await setup();
  const { createProposal } = await import('../../src/proposals/proposals.js');
  const { id } = await withTenant(t, (tx) => createProposal(tx, t, {
    type: 'task', payload: {}, rationale: {}, status: 'pending_approval',
  }));
  await withTenant(t, (tx) => approveProposal(tx, t, id));

  await expect(withTenant(t, (tx) =>
    postApprovedRecurringInvoice(tx, t, id, { ap: new StubAccessPoint() }),
  )).rejects.toThrow(/not a recurring invoice proposal/);
});

test('a failed issue rolls the approval back, leaving the proposal retryable', async () => {
  const { t, customerPartyId } = await setup();
  const { proposalId } = await generatePendingProposal(t, customerPartyId);
  // Close the period the invoice would post into: postEntry rejects a closed period.
  await withTenant(t, (tx) => closePeriod(tx, t, { year: 2026, month: 5 }));

  await expect(withTenant(t, async (tx) => {
    await approveProposal(tx, t, proposalId);
    return postApprovedRecurringInvoice(tx, t, proposalId, { ap: new StubAccessPoint() });
  })).rejects.toThrow();

  // withTenant wraps one transaction, so the approve transition rolled back with the failure.
  const prop = await withTenant(t, (tx) => getProposal(tx, t, proposalId));
  expect(prop.status).toBe('pending_approval');
});

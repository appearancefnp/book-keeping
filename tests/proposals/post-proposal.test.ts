import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createAccount } from '../../src/ledger/accounts.js';
import { openPeriod } from '../../src/ledger/periods.js';
import { getEntry } from '../../src/ledger/posting.js';
import { createDocument, getDocument } from '../../src/documents/documents.js';
import { createProposal, getProposal } from '../../src/proposals/proposals.js';
import { approveProposal, submitForApproval } from '../../src/proposals/lifecycle.js';
import { postApprovedPosting } from '../../src/proposals/post-proposal.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('approving and posting a posting-proposal creates a balanced entry and links the document', async () => {
  const t = await makeFirmAndClient();
  const { entryId, docId, proposalId } = await withTenant(ctx(t), async (tx) => {
    await createAccount(tx, ctx(t), { code: '2310', name: 'Bank', type: 'asset' });
    await createAccount(tx, ctx(t), { code: '6110', name: 'Sales', type: 'income' });
    await openPeriod(tx, ctx(t), { year: 2026, month: 3 });
    const doc = await createDocument(tx, ctx(t), { source: 'mobile', storageKey: 'k', mime: 'image/jpeg', uploadedBy: 'u' });
    const prop = await createProposal(tx, ctx(t), {
      type: 'posting',
      documentId: doc.id,
      payload: {
        date: '2026-03-10', memo: 'Sale', currency: 'EUR',
        lines: [
          { accountCode: '2310', debit: '121.00', credit: '0' },
          { accountCode: '6110', debit: '0', credit: '121.00' },
        ],
      },
      rationale: { ruleRef: 'VAT 21%' },
    });
    await submitForApproval(tx, ctx(t), prop.id);
    await approveProposal(tx, ctx(t), prop.id);
    const posted = await postApprovedPosting(tx, ctx(t), prop.id);
    return { entryId: posted.entryId, docId: doc.id, proposalId: prop.id };
  });

  const [entry, doc, prop] = await withTenant(ctx(t), async (tx) => [
    await getEntry(tx, ctx(t), entryId),
    await getDocument(tx, ctx(t), docId),
    await getProposal(tx, ctx(t), proposalId),
  ]);
  expect(entry.lines).toHaveLength(2);
  expect(entry.memo).toBe('Sale');
  expect(prop.status).toBe('posted');
  expect(prop.resolvedEntryId).toBe(entryId);
  expect(doc.status).toBe('posted');
  expect(doc.journalEntryId).toBe(entryId);
});

test('refuses to post a proposal that is not approved', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createProposal(tx, ctx(t), {
    type: 'posting', payload: { date: '2026-03-10', memo: 'x', currency: 'EUR', lines: [] }, rationale: {},
  }));
  await expect(withTenant(ctx(t), (tx) => postApprovedPosting(tx, ctx(t), id))).rejects.toThrow(/approved/i);
});

test('refuses to post a non-posting proposal', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), async (tx) => {
    const p = await createProposal(tx, ctx(t), { type: 'task', payload: {}, rationale: {}, status: 'pending_approval' });
    await approveProposal(tx, ctx(t), p.id);
    return p;
  });
  await expect(withTenant(ctx(t), (tx) => postApprovedPosting(tx, ctx(t), id))).rejects.toThrow(/posting/i);
});

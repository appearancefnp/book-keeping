import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { LocalBlobStore } from '../../src/blob/blob-store.js';
import { StubExtractor } from '../../src/intake/extractor.js';
import { createDocument, getDocument } from '../../src/documents/documents.js';
import { getProposal } from '../../src/proposals/proposals.js';
import { runIntake } from '../../src/intake/intake.js';
import type { PostingTemplate } from '../../src/intake/map-posting.js';

let dir: string;
const template: PostingTemplate = { expenseAccount: '7710', vatInputAccount: '5721', payablesAccount: '5310' };
const canned = {
  extractedData: {
    supplierName: 'SIA Piegādātājs', supplierRegNo: '40100000000', date: '2026-03-10', currency: 'EUR',
    lineItems: [{ description: 'Prece', net: '100.00', vatRate: 21, vat: '21.00' }],
    vatTotal: '21.00', netTotal: '100.00', grandTotal: '121.00',
  },
  confidence: { supplierName: 0.98, grandTotal: 0.97 },
};

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'intake-')); await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); await closeDb(); });

test('a clean document produces a posting proposal and marks the document extracted', async () => {
  const t = await makeFirmAndClient();
  const blob = new LocalBlobStore(dir);
  await blob.put('doc-1', Buffer.from('fake-image'), 'image/jpeg');

  const { proposalId, docId } = await withTenant(ctx(t), async (tx) => {
    const doc = await createDocument(tx, ctx(t), { source: 'mobile', storageKey: 'doc-1', mime: 'image/jpeg', uploadedBy: 'u' });
    const r = await runIntake(tx, ctx(t), { documentId: doc.id, blob, extractor: new StubExtractor(canned), template });
    return { proposalId: r.proposalId, docId: doc.id };
  });

  const [prop, doc] = await withTenant(ctx(t), async (tx) => [
    await getProposal(tx, ctx(t), proposalId),
    await getDocument(tx, ctx(t), docId),
  ]);
  expect(prop.type).toBe('posting');
  expect((prop.payload as { lines: unknown[] }).lines).toHaveLength(3);
  expect(prop.documentId).toBe(docId);
  expect(doc.status).toBe('extracted');
  expect(doc.extractedData).toMatchObject({ grandTotal: '121.00' });
});

test('a non-reconciling document yields needs_review + pending_approval', async () => {
  const t = await makeFirmAndClient();
  const blob = new LocalBlobStore(dir);
  await blob.put('doc-2', Buffer.from('x'), 'image/jpeg');
  const bad = { extractedData: { ...canned.extractedData, grandTotal: '999.00' }, confidence: canned.confidence };

  const { proposalId, docId, status } = await withTenant(ctx(t), async (tx) => {
    const doc = await createDocument(tx, ctx(t), { source: 'mobile', storageKey: 'doc-2', mime: 'image/jpeg', uploadedBy: 'u' });
    const r = await runIntake(tx, ctx(t), { documentId: doc.id, blob, extractor: new StubExtractor(bad), template });
    return { proposalId: r.proposalId, docId: doc.id, status: r.status };
  });

  const doc = await withTenant(ctx(t), (tx) => getDocument(tx, ctx(t), docId));
  expect(status).toBe('pending_approval');
  expect(doc.status).toBe('needs_review');
  const prop = await withTenant(ctx(t), (tx) => getProposal(tx, ctx(t), proposalId));
  expect((prop.rationale as { validationIssues?: string[] }).validationIssues?.length).toBeGreaterThan(0);
});

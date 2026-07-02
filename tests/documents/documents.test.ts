import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createDocument, getDocument, listDocuments, setDocumentStatus } from '../../src/documents/documents.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

test('a new document starts in status "received"', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createDocument(tx, ctx(t), {
    source: 'mobile', storageKey: 's3://bucket/abc.jpg', mime: 'image/jpeg', uploadedBy: 'user-1',
  }));
  const doc = await withTenant(ctx(t), (tx) => getDocument(tx, ctx(t), id));
  expect(doc.status).toBe('received');
  expect(doc.source).toBe('mobile');
  expect(doc.journalEntryId).toBeNull();
});

test('setDocumentStatus transitions status', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createDocument(tx, ctx(t), {
    source: 'web', storageKey: 'k', mime: 'application/pdf', uploadedBy: 'u',
  }));
  await withTenant(ctx(t), (tx) => setDocumentStatus(tx, ctx(t), id, 'extracting'));
  const doc = await withTenant(ctx(t), (tx) => getDocument(tx, ctx(t), id));
  expect(doc.status).toBe('extracting');
});

test('listDocuments filters by status', async () => {
  const t = await makeFirmAndClient();
  await withTenant(ctx(t), async (tx) => {
    const a = await createDocument(tx, ctx(t), { source: 'web', storageKey: 'a', mime: 'application/pdf', uploadedBy: 'u' });
    await createDocument(tx, ctx(t), { source: 'web', storageKey: 'b', mime: 'application/pdf', uploadedBy: 'u' });
    await setDocumentStatus(tx, ctx(t), a.id, 'needs_review');
  });
  const review = await withTenant(ctx(t), (tx) => listDocuments(tx, ctx(t), { status: 'needs_review' }));
  expect(review).toHaveLength(1);
});

test('rejects an invalid status', async () => {
  const t = await makeFirmAndClient();
  const { id } = await withTenant(ctx(t), (tx) => createDocument(tx, ctx(t), { source: 'web', storageKey: 'k', mime: 'x', uploadedBy: 'u' }));
  await expect(withTenant(ctx(t), (tx) => setDocumentStatus(tx, ctx(t), id, 'bogus' as never))).rejects.toThrow();
});

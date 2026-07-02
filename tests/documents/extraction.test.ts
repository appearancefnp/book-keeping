import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { createDocument, getDocument } from '../../src/documents/documents.js';
import { recordExtraction, getExtractionHistory } from '../../src/documents/extraction.js';

beforeAll(async () => { await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await closeDb(); });

async function seedDoc(t: { firmId: string; clientCompanyId: string }) {
  return withTenant(ctx(t), (tx) => createDocument(tx, ctx(t), { source: 'mobile', storageKey: 'k', mime: 'image/jpeg', uploadedBy: 'u' }));
}

test('recordExtraction stores a version and updates the document', async () => {
  const t = await makeFirmAndClient();
  const doc = await seedDoc(t);
  await withTenant(ctx(t), (tx) => recordExtraction(tx, ctx(t), doc.id, {
    extractedData: { supplier: 'SIA X', total: '121.00' },
    confidence: { supplier: 0.98, total: 0.95 },
  }));
  const updated = await withTenant(ctx(t), (tx) => getDocument(tx, ctx(t), doc.id));
  expect(updated.status).toBe('extracted');
  expect(updated.extractedData).toEqual({ supplier: 'SIA X', total: '121.00' });
});

test('multiple extractions are kept as a version history (append-only)', async () => {
  const t = await makeFirmAndClient();
  const doc = await seedDoc(t);
  await withTenant(ctx(t), async (tx) => {
    await recordExtraction(tx, ctx(t), doc.id, { extractedData: { total: '100.00' }, confidence: {} });
    await recordExtraction(tx, ctx(t), doc.id, { extractedData: { total: '121.00' }, confidence: {} });
  });
  const history = await withTenant(ctx(t), (tx) => getExtractionHistory(tx, ctx(t), doc.id));
  expect(history).toHaveLength(2);
  // latest reflected on the document
  const updated = await withTenant(ctx(t), (tx) => getDocument(tx, ctx(t), doc.id));
  expect(updated.extractedData).toEqual({ total: '121.00' });
});

test('document_versions is append-only: UPDATE is blocked', async () => {
  const t = await makeFirmAndClient();
  const doc = await seedDoc(t);
  const { versionId } = await withTenant(ctx(t), (tx) => recordExtraction(tx, ctx(t), doc.id, { extractedData: { a: 1 }, confidence: {} }));
  await expect(withTenant(ctx(t), (tx) =>
    tx.query("UPDATE document_versions SET extracted_data = '{}'::jsonb WHERE id = $1", [versionId]),
  )).rejects.toThrow(/permission denied|append-only/i);
});

import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDb, closeDb, makeFirmAndClient, ctx } from '../helpers/db.js';
import { withTenant } from '../../src/db/pool.js';
import { LocalBlobStore } from '../../src/blob/blob-store.js';
import { StubExtractor } from '../../src/intake/extractor.js';
import { storeExpenseReceipt } from '../../src/expenses/upload.js';

const CANNED = {
  extractedData: {
    supplierName: 'Statoil', supplierRegNo: null, date: '2026-07-15', currency: 'EUR',
    lineItems: [{ description: 'Fuel', net: '41.32', vatRate: 21, vat: '8.68' }],
    vatTotal: '8.68', netTotal: '41.32', grandTotal: '50.00',
  },
  confidence: { supplierName: 0.9, grandTotal: 0.95 },
};

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'expense-upload-')); await resetDb(); });
beforeEach(async () => { await resetDb(); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); await closeDb(); });

test('storeExpenseReceipt creates a document (source expense, status received), touches no proposal, and returns a prefill suggestion', async () => {
  const t = ctx(await makeFirmAndClient());
  const blobStore = new LocalBlobStore(dir);
  const extractor = new StubExtractor(CANNED);

  const before = await withTenant(t, (tx) => tx.query(`SELECT count(*)::int AS n FROM proposals`));
  expect(before.rows[0].n).toBe(0);

  const { documentId, suggestion } = await withTenant(t, (tx) => storeExpenseReceipt(tx, t, {
    bytes: Buffer.from('fake-receipt'), mimeType: 'image/jpeg', filename: 'receipt.jpg', blobStore, extractor,
  }));

  expect(documentId).toBeTruthy();
  expect(suggestion).toEqual({ amount: '50.00', date: '2026-07-15', merchant: 'Statoil' });

  const doc = await withTenant(t, (tx) => tx.query(
    `SELECT source, status FROM documents WHERE id = $1 AND client_company_id = $2`, [documentId, t.clientCompanyId],
  ));
  expect(doc.rows[0]).toEqual({ source: 'expense', status: 'received' });

  const after = await withTenant(t, (tx) => tx.query(`SELECT count(*)::int AS n FROM proposals`));
  expect(after.rows[0].n).toBe(0);

  const stored = await blobStore.get((await withTenant(t, (tx) => tx.query(
    `SELECT storage_key AS "storageKey" FROM documents WHERE id = $1`, [documentId],
  ))).rows[0].storageKey);
  expect(stored.bytes.toString()).toBe('fake-receipt');
  expect(stored.mime).toBe('image/jpeg');
});

test('storeExpenseReceipt sanitizes the filename before building the storage key (no path traversal)', async () => {
  const t = ctx(await makeFirmAndClient());
  const blobStore = new LocalBlobStore(dir);
  const extractor = new StubExtractor(CANNED);

  const { documentId } = await withTenant(t, (tx) => storeExpenseReceipt(tx, t, {
    bytes: Buffer.from('x'), mimeType: 'application/pdf', filename: '../../evil .pdf', blobStore, extractor,
  }));

  const row = await withTenant(t, (tx) => tx.query(
    `SELECT storage_key AS "storageKey" FROM documents WHERE id = $1`, [documentId],
  ));
  const storageKey = row.rows[0].storageKey as string;
  const prefix = `${t.clientCompanyId}/expenses/`;
  expect(storageKey.startsWith(prefix)).toBe(true);
  const suffix = storageKey.slice(prefix.length);
  // Must not escape the tenant/expenses prefix: no traversal segments, no extra path separators.
  expect(suffix).not.toContain('..');
  expect(suffix).not.toContain('/');

  // The blob is still retrievable at the sanitized key (the write actually used it).
  const stored = await blobStore.get(storageKey);
  expect(stored.bytes.toString()).toBe('x');
});

test('storeExpenseReceipt degrades to an empty suggestion when the extractor returns an unparseable shape', async () => {
  const t = ctx(await makeFirmAndClient());
  const blobStore = new LocalBlobStore(dir);
  const badExtractor = new StubExtractor({ extractedData: { nonsense: true } as never, confidence: {} });

  const { documentId, suggestion } = await withTenant(t, (tx) => storeExpenseReceipt(tx, t, {
    bytes: Buffer.from('x'), mimeType: 'image/png', filename: 'r.png', blobStore, extractor: badExtractor,
  }));

  expect(documentId).toBeTruthy();
  expect(suggestion).toEqual({});
});

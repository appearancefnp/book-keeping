import { afterEach, expect, test } from 'vitest';
import { makeBlobStore } from '../../src/blob/factory.js';
import { LocalBlobStore } from '../../src/blob/blob-store.js';
import { VercelBlobStore } from '../../src/blob/vercel-blob-store.js';

const saved = process.env.BLOB_READ_WRITE_TOKEN;
afterEach(() => {
  if (saved === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = saved;
});

test('returns LocalBlobStore without a Vercel token', () => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  expect(makeBlobStore()).toBeInstanceOf(LocalBlobStore);
});

test('returns VercelBlobStore when BLOB_READ_WRITE_TOKEN is set', () => {
  process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_test_token';
  expect(makeBlobStore()).toBeInstanceOf(VercelBlobStore);
});

import { expect, test } from 'vitest';
import { blobConfigStatus } from '../../src/blob/config-status.js';

test('misconfigured only when deployed to Vercel without a blob token', () => {
  expect(blobConfigStatus({ VERCEL_ENV: 'production' })).toBe('misconfigured');
  expect(blobConfigStatus({ VERCEL_ENV: 'preview' })).toBe('misconfigured');
  expect(blobConfigStatus({ VERCEL_ENV: 'production', BLOB_READ_WRITE_TOKEN: 'x' })).toBe('ok');
  expect(blobConfigStatus({})).toBe('ok'); // local dev: LocalBlobStore is fine
  expect(blobConfigStatus({ BLOB_READ_WRITE_TOKEN: 'x' })).toBe('ok');
});

import { type BlobStore, LocalBlobStore } from './blob-store.js';
import { VercelBlobStore } from './vercel-blob-store.js';
import { blobConfigStatus } from './config-status.js';

// Destructured (not `process.env` wholesale): under some tsconfigs (e.g. web/, where
// Next.js augments NodeJS.ProcessEnv with a required NODE_ENV literal), passing the
// whole ProcessEnv to a function typed with unrelated optional keys trips TS2559
// ("no properties in common") — a known weak-type-detection quirk.
const { VERCEL_ENV, BLOB_READ_WRITE_TOKEN } = process.env;
if (blobConfigStatus({ VERCEL_ENV, BLOB_READ_WRITE_TOKEN }) === 'misconfigured') {
  console.warn('[blob] VERCEL_ENV is set but BLOB_READ_WRITE_TOKEN is not — uploads will fail (EROFS). Configure Vercel Blob.');
}

/** Vercel Blob when the platform token is present, local filesystem otherwise (dev/tests). */
export function makeBlobStore(): BlobStore {
  if (process.env.BLOB_READ_WRITE_TOKEN) return new VercelBlobStore();
  return new LocalBlobStore(process.env.BLOB_DIR ?? '.blob-store');
}

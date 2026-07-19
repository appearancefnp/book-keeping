import { type BlobStore, LocalBlobStore } from './blob-store.js';
import { VercelBlobStore } from './vercel-blob-store.js';

/** Vercel Blob when the platform token is present, local filesystem otherwise (dev/tests). */
export function makeBlobStore(): BlobStore {
  if (process.env.BLOB_READ_WRITE_TOKEN) return new VercelBlobStore();
  return new LocalBlobStore(process.env.BLOB_DIR ?? '.blob-store');
}

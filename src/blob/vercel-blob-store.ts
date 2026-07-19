import type { BlobStore } from './blob-store.js';

/**
 * Vercel Blob-backed store. Keys map 1:1 to blob pathnames, so existing DB
 * references keep working. Requires BLOB_READ_WRITE_TOKEN (Vercel injects it
 * automatically when a Blob store is linked to the project).
 *
 * Uses `access: 'private'` (supported by the installed @vercel/blob SDK,
 * v2.6.1): objects require an authenticated request (the read-write token)
 * to fetch, whether by pathname (as we do here) or by URL. The store never
 * returns or logs a blob URL to callers — `get()` reads the stream itself
 * and hands back bytes+mime, so the interface never leaks a fetchable link.
 *
 * `@vercel/blob` is declared as a root dependency (like `pg`/`zod`, which
 * this same `src/` tree also depends on) rather than under `web/`, because
 * this file physically lives at `src/blob/` — Node-style module resolution
 * (used by both tsc projects and by webpack) walks up ancestors of the
 * *importing file's own directory*, and `web/node_modules` is not an
 * ancestor of `src/blob/` (it's a sibling subtree), so a `web`-only install
 * is invisible from here in every tool that matters (root tsc, web tsc, and
 * webpack's bundling for the Next.js build/deploy trace all failed to
 * resolve it when tried). Root's `node_modules` *is* an ancestor of both
 * `src/` and `web/`, and matches how Next.js already treats the monorepo
 * root for output-file tracing (see docs/RUNNING.md's Vercel deploy notes).
 *
 * The import is still lazy (`await import(...)` inside each method, literal
 * specifier so bundlers can trace it statically) purely so root `tsc`/vitest
 * never need to execute this module — `makeBlobStore()` only constructs this
 * class when `BLOB_READ_WRITE_TOKEN` is set, which tests never set.
 */
export class VercelBlobStore implements BlobStore {
  async put(key: string, bytes: Buffer, mime: string): Promise<void> {
    const { put } = await import('@vercel/blob');
    await put(key, bytes, {
      access: 'private',
      contentType: mime,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  }

  async get(key: string): Promise<{ bytes: Buffer; mime: string }> {
    const { get } = await import('@vercel/blob');
    // useCache: false — most keys are immutable (UUID document keys), but the
    // invoice-logo key (invoice-logo/<clientCompanyId>) is overwritten in
    // place via put()'s allowOverwrite: true and re-read by the invoice
    // document page. At this app's volume, correctness of re-uploaded content
    // outweighs the latency saved by CDN read caching, so always fetch fresh
    // from origin rather than risk serving a stale blob for the cache TTL.
    const result = await get(key, { access: 'private', useCache: false });
    if (!result) throw new Error(`blob not found: ${key}`);
    if (result.statusCode !== 200) throw new Error(`blob fetch failed: status ${result.statusCode}`);
    const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
    const mime = result.blob.contentType ?? 'application/octet-stream';
    return { bytes, mime };
  }
}

import { randomUUID } from 'node:crypto';
import { withTenant } from '../db/pool.js';
import { authed } from './handlers.js';
import type { AuthedRequest, ApiResponse } from './types.js';
import type { BlobStore } from '../blob/blob-store.js';
import type { DocumentExtractor } from '../intake/extractor.js';
import { createDocument } from '../documents/documents.js';
import { runIntake } from '../intake/intake.js';
import type { PostingTemplate } from '../intake/map-posting.js';

export function makeCaptureHandler(deps: {
  blob: BlobStore; extractor: DocumentExtractor; resolveTemplate: (clientCompanyId: string) => PostingTemplate;
}): (req: AuthedRequest) => Promise<ApiResponse> {
  return (req) => authed(req, async (ctx) => {
    const body = (req.body ?? {}) as { bytesBase64?: string; mime?: string };
    if (!body.bytesBase64 || !body.mime) return { status: 400, body: { error: 'bytesBase64 and mime are required' } };

    const bytes = Buffer.from(body.bytesBase64, 'base64');
    const storageKey = `${ctx.clientCompanyId}/${randomUUID()}`;
    // blob.put happens before withTenant: object storage is not transactional.
    // If the DB transaction rolls back, an orphan blob remains under storageKey with no document row —
    // harmless (unreferenced), and a periodic sweep can GC orphans. Accepted MVP behavior (same class
    // as the Plan 6 dual-write note).
    await deps.blob.put(storageKey, bytes, body.mime);

    const result = await withTenant(ctx, async (tx) => {
      const doc = await createDocument(tx, ctx, { source: 'mobile', storageKey, mime: body.mime!, uploadedBy: ctx.actorId });
      const intake = await runIntake(tx, ctx, { documentId: doc.id, blob: deps.blob, extractor: deps.extractor, template: deps.resolveTemplate(ctx.clientCompanyId) });
      return { documentId: doc.id, proposalId: intake.proposalId, status: intake.status };
    });
    return { status: 200, body: result };
  });
}

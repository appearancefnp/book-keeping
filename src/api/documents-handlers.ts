import { withTenant } from '../db/pool.js';
import { authed } from './handlers.js';
import type { AuthedRequest, ApiResponse } from './types.js';
import { listDocuments, getDocument, type DocumentStatus } from '../documents/documents.js';

export function documentsHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const status = (req.params?.status as DocumentStatus | undefined) ?? undefined;
    const documents = await withTenant(ctx, (tx) => listDocuments(tx, ctx, status ? { status } : {}));
    return { status: 200, body: { documents } };
  });
}

export function documentHandler(req: AuthedRequest): Promise<ApiResponse> {
  return authed(req, async (ctx) => {
    const id = req.params?.id;
    if (!id) return { status: 400, body: { error: 'missing document id' } };
    try {
      const document = await withTenant(ctx, (tx) => getDocument(tx, ctx, id));
      return { status: 200, body: { document } };
    } catch {
      return { status: 404, body: { error: 'document not found' } };
    }
  });
}

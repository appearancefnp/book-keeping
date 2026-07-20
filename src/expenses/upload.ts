import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { BlobStore } from '../blob/blob-store.js';
import type { DocumentExtractor } from '../intake/extractor.js';
import { extractedInvoiceSchema } from '../intake/extraction-schema.js';
import { createDocument } from '../documents/documents.js';

export interface ExpenseReceiptSuggestion { amount?: string; date?: string; merchant?: string; }

/**
 * Store a receipt photo/scan for an expense-claim line: a `documents` row (source 'expense',
 * status 'received') plus a best-effort AI prefill suggestion — but, unlike `runIntake`
 * (src/intake/intake.ts), NO proposal and no posting draft. An expense receipt isn't a
 * purchase invoice to book on its own; it just backs a claim line the employee fills in by
 * hand, so the extractor result is offered as a *suggestion* to prefill that form, not parsed
 * into a binding entry. The extractor's output is validated defensively (safeParse): a
 * malformed/partial extraction degrades to an empty suggestion rather than failing the upload.
 */
export async function storeExpenseReceipt(
  tx: PoolClient, ctx: TenantContext,
  args: { bytes: Buffer; mimeType: string; filename: string; blobStore: BlobStore; extractor: DocumentExtractor },
): Promise<{ documentId: string; suggestion: ExpenseReceiptSuggestion }> {
  // Sanitize the attacker-controlled filename before it becomes part of the blob store key: a
  // raw '../../other-tenant/x' would otherwise escape the tenant/expenses key prefix. Drop any
  // directory components first (split on both slash styles and keep only the last segment) —
  // a plain character-allowlist replace alone is NOT enough, since '.' is a legitimate filename
  // character: "../../evil.pdf" would replace only the slashes and still leave literal '..'
  // substrings behind. randomUUID already guarantees uniqueness; this just keeps a readable,
  // traversal-free suffix.
  const baseName = args.filename.split(/[\\/]+/).pop() || 'file';
  const safeName = baseName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '') || 'file';
  const storageKey = `${ctx.clientCompanyId}/expenses/${randomUUID()}-${safeName}`;
  // Blob write precedes the DB transaction (object storage isn't transactional) — same accepted
  // orphan-on-rollback tradeoff as makeCaptureHandler (src/api/capture-handler.ts).
  await args.blobStore.put(storageKey, args.bytes, args.mimeType);

  const doc = await createDocument(tx, ctx, {
    source: 'expense', storageKey, mime: args.mimeType, uploadedBy: ctx.actorId,
  });

  let suggestion: ExpenseReceiptSuggestion = {};
  try {
    const result = await args.extractor.extract(args.bytes, args.mimeType);
    const parsed = extractedInvoiceSchema.safeParse(result.extractedData);
    if (parsed.success) {
      suggestion = { amount: parsed.data.grandTotal, date: parsed.data.date, merchant: parsed.data.supplierName };
    }
  } catch {
    // Best-effort prefill: an extractor failure (network, provider error, bad shape) must not
    // fail the upload — the employee can still fill in the claim line manually.
  }

  return { documentId: doc.id, suggestion };
}

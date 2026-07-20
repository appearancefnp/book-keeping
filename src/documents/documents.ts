import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type DocumentSource = 'mobile' | 'web' | 'email' | 'peppol' | 'expense';
export type DocumentStatus = 'received' | 'extracting' | 'extracted' | 'needs_review' | 'posted' | 'rejected';
export interface DocumentRow {
  id: string; source: DocumentSource; storageKey: string; mime: string; status: DocumentStatus;
  partyId: string | null; journalEntryId: string | null; extractedData: unknown | null;
}

const STATUSES = ['received', 'extracting', 'extracted', 'needs_review', 'posted', 'rejected'] as const;
const newDocSchema = z.object({
  source: z.enum(['mobile', 'web', 'email', 'peppol', 'expense']),
  storageKey: z.string().min(1),
  mime: z.string().min(1),
  uploadedBy: z.string().min(1),
});
const statusSchema = z.enum(STATUSES);

const SELECT_COLS =
  'id, source, storage_key AS "storageKey", mime, status, party_id AS "partyId", journal_entry_id AS "journalEntryId", extracted_data AS "extractedData"';

export async function createDocument(
  tx: PoolClient, ctx: TenantContext,
  input: { source: DocumentSource; storageKey: string; mime: string; uploadedBy: string },
): Promise<{ id: string }> {
  const d = newDocSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO documents(client_company_id, source, storage_key, mime, uploaded_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.clientCompanyId, d.source, d.storageKey, d.mime, d.uploadedBy],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'document', entityId: id, before: null, after: d });
  return { id };
}

export async function getDocument(tx: PoolClient, ctx: TenantContext, id: string): Promise<DocumentRow> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM documents WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Document not found: ${id}`);
  return res.rows[0];
}

export async function listDocuments(
  tx: PoolClient, ctx: TenantContext,
  filter: { status?: DocumentStatus; limit?: number; offset?: number } = {},
): Promise<DocumentRow[]> {
  // LIMIT NULL / OFFSET NULL are no-ops in Postgres, so omitted paging keeps the old behavior.
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM documents
     WHERE client_company_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at DESC
     LIMIT $3::int OFFSET $4::int`,
    [ctx.clientCompanyId, filter.status ?? null, filter.limit ?? null, filter.offset ?? null],
  );
  return res.rows;
}

export async function setDocumentStatus(
  tx: PoolClient, ctx: TenantContext, id: string, status: DocumentStatus,
): Promise<void> {
  const s = statusSchema.parse(status);
  const res = await tx.query(
    `UPDATE documents SET status = $1, updated_at = now()
     WHERE id = $2 AND client_company_id = $3`,
    [s, id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Document not found: ${id}`);
  await appendAudit(tx, ctx, { action: 'status', entityType: 'document', entityId: id, before: null, after: { status: s } });
}

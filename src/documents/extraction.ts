import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export interface ExtractionVersion { id: string; extractedData: unknown; confidence: unknown; createdAt: string; }

export async function recordExtraction(
  tx: PoolClient, ctx: TenantContext, documentId: string,
  extraction: { extractedData: unknown; confidence: unknown },
): Promise<{ versionId: string }> {
  // Insert an immutable version row.
  const ver = await tx.query(
    `INSERT INTO document_versions(client_company_id, document_id, extracted_data, confidence)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [ctx.clientCompanyId, documentId, JSON.stringify(extraction.extractedData), JSON.stringify(extraction.confidence)],
  );
  const versionId = ver.rows[0].id as string;

  // Reflect the latest extraction on the document + advance status to 'extracted'.
  const upd = await tx.query(
    `UPDATE documents SET extracted_data = $1, status = 'extracted', updated_at = now()
     WHERE id = $2 AND client_company_id = $3`,
    [JSON.stringify(extraction.extractedData), documentId, ctx.clientCompanyId],
  );
  if (!upd.rowCount) throw new Error(`Document not found: ${documentId}`);

  await appendAudit(tx, ctx, {
    action: 'extract', entityType: 'document', entityId: documentId,
    before: null, after: { versionId },
  });
  return { versionId };
}

export async function getExtractionHistory(
  tx: PoolClient, ctx: TenantContext, documentId: string,
): Promise<ExtractionVersion[]> {
  const res = await tx.query(
    `SELECT id, extracted_data AS "extractedData", confidence, created_at AS "createdAt"
     FROM document_versions
     WHERE document_id = $1 AND client_company_id = $2
     ORDER BY created_at ASC, id ASC`,
    [documentId, ctx.clientCompanyId],
  );
  return res.rows;
}

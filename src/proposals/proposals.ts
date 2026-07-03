import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { appendAudit } from '../audit/audit.js';

export type ProposalType = 'posting' | 'bank_match' | 'declaration' | 'task';
export type ProposalStatus = 'suggested' | 'pending_approval' | 'approved' | 'rejected' | 'posted';
export interface Rationale { ruleRef?: string; computation?: string; sourceRefs?: unknown; }
export interface ProposalRow {
  id: string; type: ProposalType; status: ProposalStatus; payload: unknown; rationale: Rationale;
  documentId: string | null; resolvedEntryId: string | null; rejectReason: string | null;
}

const newProposalSchema = z.object({
  type: z.enum(['posting', 'bank_match', 'declaration', 'task']),
  payload: z.unknown(),
  rationale: z.object({ ruleRef: z.string().optional(), computation: z.string().optional(), sourceRefs: z.unknown().optional() }).passthrough(),
  documentId: z.string().uuid().nullable().optional(),
  status: z.enum(['suggested', 'pending_approval', 'approved', 'rejected', 'posted']).optional(),
});

const SELECT_COLS =
  'id, type, status, payload, rationale, document_id AS "documentId", resolved_entry_id AS "resolvedEntryId", reject_reason AS "rejectReason"';

export async function createProposal(
  tx: PoolClient, ctx: TenantContext,
  input: { type: ProposalType; payload: unknown; rationale: Rationale; documentId?: string | null; status?: ProposalStatus },
): Promise<{ id: string }> {
  const p = newProposalSchema.parse(input);
  const res = await tx.query(
    `INSERT INTO proposals(client_company_id, type, status, payload, rationale, document_id)
     VALUES ($1,$2,COALESCE($3,'suggested'),$4,$5,$6) RETURNING id`,
    [ctx.clientCompanyId, p.type, p.status ?? null, JSON.stringify(p.payload), JSON.stringify(p.rationale), p.documentId ?? null],
  );
  const id = res.rows[0].id as string;
  await appendAudit(tx, ctx, { action: 'create', entityType: 'proposal', entityId: id, before: null, after: { type: p.type, status: p.status ?? 'suggested' } });
  return { id };
}

export async function getProposal(tx: PoolClient, ctx: TenantContext, id: string): Promise<ProposalRow> {
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM proposals WHERE id = $1 AND client_company_id = $2`,
    [id, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error(`Proposal not found: ${id}`);
  return res.rows[0];
}

export async function listProposals(
  tx: PoolClient, ctx: TenantContext,
  filter: { status?: ProposalStatus; limit?: number; offset?: number } = {},
): Promise<ProposalRow[]> {
  // LIMIT NULL / OFFSET NULL are no-ops in Postgres, so omitted paging keeps the old behavior.
  const res = await tx.query(
    `SELECT ${SELECT_COLS} FROM proposals
     WHERE client_company_id = $1 AND ($2::text IS NULL OR status = $2)
     ORDER BY created_at ASC
     LIMIT $3::int OFFSET $4::int`,
    [ctx.clientCompanyId, filter.status ?? null, filter.limit ?? null, filter.offset ?? null],
  );
  return res.rows;
}

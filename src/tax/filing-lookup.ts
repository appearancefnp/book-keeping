import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

/**
 * The prepared filing for a period, or null if none was prepared.
 *
 * Both filing proposal creators (createVatDeclarationProposal, createEcslProposal) record the
 * period on rationale.sourceRefs.period as { fromDate, toDate }; this reads it back so /filings can
 * show prepared/approved state across a page reload instead of relying on the POST response it
 * happens to still hold in memory.
 *
 * Newest wins: preparing the same period twice is allowed (nothing constrains it), and the latest
 * attempt is the one an accountant means. Ordered by created_at then id so the result is
 * deterministic when two rows share a timestamp.
 */
export async function findFilingProposal(
  tx: PoolClient, ctx: TenantContext,
  args: { type: 'declaration' | 'ecsl'; fromDate: string; toDate: string },
): Promise<{ id: string; status: string } | null> {
  const res = await tx.query(
    `SELECT id, status FROM proposals
      WHERE client_company_id = $1
        AND type = $2
        AND rationale -> 'sourceRefs' -> 'period' ->> 'fromDate' = $3
        AND rationale -> 'sourceRefs' -> 'period' ->> 'toDate' = $4
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [ctx.clientCompanyId, args.type, args.fromDate, args.toDate],
  );
  return res.rowCount ? { id: res.rows[0].id, status: res.rows[0].status } : null;
}

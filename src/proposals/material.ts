import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { listProposals, type ProposalRow } from './proposals.js';
import { sumCents } from '../db/money.js';

// €1000 — matches setAutonomy's default in src/autonomy/autonomy.ts.
const DEFAULT_THRESHOLD_CENTS = 100000n;

/** Amount (integer cents) a proposal represents, or null if none is derivable. */
function proposalAmountCents(row: ProposalRow): bigint | null {
  const payload = row.payload as { lines?: { debit?: string }[]; amountCents?: string } | null;
  if (row.type === 'posting') {
    const debits = (payload?.lines ?? []).map((l) => l.debit ?? '0');
    return debits.length ? sumCents(debits) : null;
  }
  if (row.type === 'bank_match') {
    return payload?.amountCents !== undefined ? BigInt(payload.amountCents) : null;
  }
  return null; // task, or no amount
}

/**
 * Proposals awaiting approval that are "material" for the owner-calm view (G3):
 * every declaration (hard-gated), plus any proposal whose amount ≥ the client's
 * per-operation material threshold (autonomy policy; default €1000 when unset).
 */
export async function listMaterialApprovals(
  tx: PoolClient, ctx: TenantContext,
): Promise<ProposalRow[]> {
  const pending = await listProposals(tx, ctx, { status: 'pending_approval' });

  // One read of all thresholds for this client → Map<operationType, cents>.
  const res = await tx.query(
    `SELECT operation_type AS "op", material_threshold_cents::text AS "threshold"
     FROM autonomy_policy WHERE client_company_id = $1`,
    [ctx.clientCompanyId],
  );
  const thresholds = new Map<string, bigint>(
    res.rows.map((r) => [r.op as string, BigInt(r.threshold)]),
  );

  return pending.filter((row) => {
    if (row.type === 'declaration' || row.type === 'ecsl') return true; // filings are always material
    const amount = proposalAmountCents(row);
    if (amount === null) return false;
    const threshold = thresholds.get(row.type) ?? DEFAULT_THRESHOLD_CENTS;
    return amount >= threshold;
  });
}

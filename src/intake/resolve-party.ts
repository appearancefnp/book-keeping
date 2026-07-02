import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { ExtractedInvoice } from './extraction-schema.js';
import { listParties } from '../parties/parties.js';

/** Find an existing vendor/both party matching the supplier reg number; otherwise flag as new. */
export async function resolveParty(
  tx: PoolClient, ctx: TenantContext, x: ExtractedInvoice,
): Promise<{ partyId: string | null; isNew: boolean }> {
  if (!x.supplierRegNo) return { partyId: null, isNew: true };
  const parties = await listParties(tx, ctx);
  const match = parties.find((p) => (p.kind === 'vendor' || p.kind === 'both') && p.regNo === x.supplierRegNo);
  return match ? { partyId: match.id, isNew: false } : { partyId: null, isNew: true };
}

import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

/** Roles that see every claim in the client (used for reads: getClaim/listClaims). */
export function canSeeAllClaims(role: string): boolean {
  return role === 'firm_admin' || role === 'accountant' || role === 'owner';
}

/** Roles that act as themselves only — writes are self-scoped even though 'owner' can read all. */
const CLIENT_SIDE_ROLES = new Set(['employee', 'owner']);

/** The employee row (if any) linked to this actor via employees.user_id. */
export async function ownEmployeeId(tx: PoolClient, ctx: TenantContext): Promise<string | null> {
  const res = await tx.query(
    `SELECT id FROM employees WHERE client_company_id = $1 AND user_id = $2`,
    [ctx.clientCompanyId, ctx.actorId],
  );
  return res.rows[0]?.id ?? null;
}

/**
 * Resolve the employee the actor may write a claim for. Firm-side roles (firm_admin,
 * accountant, ...) pass any requested employeeId through unchanged — they act on behalf of
 * others. Client-side roles (employee, owner) must be linked via employees.user_id =
 * ctx.actorId and may only act as themselves: an unlinked actor gets "Not linked to an
 * employee"; a requested employeeId that isn't their own gets "Forbidden: not your claim".
 */
export async function resolveClaimEmployee(
  tx: PoolClient, ctx: TenantContext, requestedEmployeeId: string | null,
): Promise<string> {
  if (!CLIENT_SIDE_ROLES.has(ctx.actorRole)) {
    if (!requestedEmployeeId) throw new Error('employeeId is required');
    return requestedEmployeeId;
  }
  const own = await ownEmployeeId(tx, ctx);
  if (!own) throw new Error('Not linked to an employee');
  if (requestedEmployeeId && requestedEmployeeId !== own) throw new Error('Forbidden: not your claim');
  return own;
}

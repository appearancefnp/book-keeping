import { appPool } from '../db/pool.js';
import { validateSession } from './sessions.js';
import type { TenantContext } from '../tenancy/context.js';

export async function assignUserToClient(userId: string, clientCompanyId: string): Promise<void> {
  await appPool.query(
    `INSERT INTO user_client_assignments(user_id, client_company_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [userId, clientCompanyId],
  );
}

/** Validate the session AND that the user is assigned to the client, then build a TenantContext. */
export async function resolveTenantContext(
  token: string, clientCompanyId: string, atUnixSeconds: number,
): Promise<TenantContext> {
  const session = await validateSession(token, atUnixSeconds);
  if (!session) throw new Error('Invalid or expired session');

  const assigned = await appPool.query(
    `SELECT 1 FROM user_client_assignments a
     JOIN client_companies c ON c.id = a.client_company_id
     WHERE a.user_id = $1 AND a.client_company_id = $2 AND c.firm_id = $3`,
    [session.userId, clientCompanyId, session.firmId],
  );
  if (!assigned.rowCount) throw new Error('User is not authorized for this client company');

  return { firmId: session.firmId, clientCompanyId, actorId: session.userId, actorRole: session.role };
}

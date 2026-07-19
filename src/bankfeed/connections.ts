import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { BankFeedProvider } from './provider.js';
import { appendAudit } from '../audit/audit.js';

export interface FeedAccountRow { id: string; providerAccountId: string; iban: string; currency: string; lastSyncedDate: string | null }
export interface FeedConnectionRow {
  id: string; provider: string; providerRequisitionId: string; institutionId: string; institutionName: string;
  status: string; consentExpiresAt: string | null; lastError: string; createdAt: string; accounts: FeedAccountRow[];
}

const CONN_COLS = `id, provider, provider_requisition_id AS "providerRequisitionId",
  institution_id AS "institutionId", institution_name AS "institutionName", status,
  consent_expires_at::text AS "consentExpiresAt", last_error AS "lastError", created_at::text AS "createdAt"`;

async function accountsFor(tx: PoolClient, ctx: TenantContext, connectionIds: string[]): Promise<Map<string, FeedAccountRow[]>> {
  const map = new Map<string, FeedAccountRow[]>();
  if (!connectionIds.length) return map;
  const res = await tx.query(
    `SELECT connection_id AS "connectionId", id, provider_account_id AS "providerAccountId",
            iban, trim(currency) AS currency, last_synced_date::text AS "lastSyncedDate"
     FROM bank_feed_accounts
     WHERE client_company_id = $1 AND connection_id = ANY($2::uuid[])
     ORDER BY iban`,
    [ctx.clientCompanyId, connectionIds],
  );
  for (const r of res.rows) {
    const list = map.get(r.connectionId) ?? [];
    list.push({ id: r.id, providerAccountId: r.providerAccountId, iban: r.iban, currency: r.currency, lastSyncedDate: r.lastSyncedDate });
    map.set(r.connectionId, list);
  }
  return map;
}

export async function getConnection(tx: PoolClient, ctx: TenantContext, connectionId: string): Promise<FeedConnectionRow> {
  const res = await tx.query(
    `SELECT ${CONN_COLS} FROM bank_feed_connections WHERE id = $1 AND client_company_id = $2`,
    [connectionId, ctx.clientCompanyId],
  );
  if (!res.rowCount) throw new Error('bank feed connection not found');
  const accounts = await accountsFor(tx, ctx, [connectionId]);
  return { ...res.rows[0], accounts: accounts.get(connectionId) ?? [] } as FeedConnectionRow;
}

export async function listConnections(tx: PoolClient, ctx: TenantContext): Promise<FeedConnectionRow[]> {
  const res = await tx.query(
    `SELECT ${CONN_COLS} FROM bank_feed_connections WHERE client_company_id = $1 ORDER BY created_at DESC`,
    [ctx.clientCompanyId],
  );
  const accounts = await accountsFor(tx, ctx, res.rows.map((r) => r.id));
  return res.rows.map((r) => ({ ...r, accounts: accounts.get(r.id) ?? [] })) as FeedConnectionRow[];
}

export async function createConnection(
  tx: PoolClient, ctx: TenantContext, provider: BankFeedProvider,
  input: { connectionId: string; institutionId: string; institutionName: string; redirectUrl: string },
): Promise<{ connectionId: string; consentUrl: string }> {
  const { requisitionId, consentUrl } = await provider.startConsent(input.institutionId, input.redirectUrl, input.connectionId);
  await tx.query(
    `INSERT INTO bank_feed_connections (id, client_company_id, provider, provider_requisition_id, institution_id, institution_name)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.connectionId, ctx.clientCompanyId, provider.name, requisitionId, input.institutionId, input.institutionName],
  );
  await appendAudit(tx, ctx, {
    action: 'create', entityType: 'bank_feed_connection', entityId: input.connectionId,
    before: null, after: { institutionId: input.institutionId, requisitionId },
  });
  return { connectionId: input.connectionId, consentUrl };
}

/** After the bank redirect: pull requisition state, store accounts, update status. Idempotent. */
export async function finalizeConnection(
  tx: PoolClient, ctx: TenantContext, provider: BankFeedProvider, connectionId: string,
): Promise<FeedConnectionRow> {
  const before = await getConnection(tx, ctx, connectionId);
  const req = await provider.getRequisition(before.providerRequisitionId);
  await tx.query(
    `UPDATE bank_feed_connections SET status = $1, consent_expires_at = $2, updated_at = now()
     WHERE id = $3 AND client_company_id = $4`,
    [req.status, req.consentExpiresAt, connectionId, ctx.clientCompanyId],
  );
  for (const a of req.accounts) {
    await tx.query(
      `INSERT INTO bank_feed_accounts (connection_id, client_company_id, provider_account_id, iban, currency)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (connection_id, provider_account_id) DO NOTHING`,
      [connectionId, ctx.clientCompanyId, a.providerAccountId, a.iban, a.currency],
    );
  }
  await appendAudit(tx, ctx, {
    action: 'finalize', entityType: 'bank_feed_connection', entityId: connectionId,
    before: { status: before.status }, after: { status: req.status, accounts: req.accounts.length },
  });
  return getConnection(tx, ctx, connectionId);
}

export async function deleteConnection(
  tx: PoolClient, ctx: TenantContext, provider: BankFeedProvider, connectionId: string,
): Promise<void> {
  const row = await getConnection(tx, ctx, connectionId);
  try { await provider.deleteRequisition(row.providerRequisitionId); } catch { /* best-effort: local removal must not depend on the provider */ }
  await tx.query(`DELETE FROM bank_feed_connections WHERE id = $1 AND client_company_id = $2`, [connectionId, ctx.clientCompanyId]);
  await appendAudit(tx, ctx, {
    action: 'delete', entityType: 'bank_feed_connection', entityId: connectionId,
    before: { requisitionId: row.providerRequisitionId, status: row.status }, after: null,
  });
}

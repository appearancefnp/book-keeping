import type { PoolClient } from 'pg';
import { DatabaseError } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import type { BankFeedProvider } from './provider.js';
import type { BankStatement } from '../banking/camt-parser.js';
import { importStatement } from '../banking/import.js';
import { proposeMatches, proposeApMatches } from '../banking/match.js';
import { feedTxnToBankTxn } from './normalize.js';
import { appendAudit } from '../audit/audit.js';

// Same hard-coded LR chart defaults as the camt.053 import route and src/dev/seed.ts
// (documented account-mapping debt — see HANDOFF.md).
const AR_MATCH = { receivablesAccount: '2310', bankAccount: '2620' };
const AP_MATCH = { payablesAccount: '5310', bankAccount: '2620', bankClearingAccount: '2699' };

export const FIRST_SYNC_DAYS = 90; // GoCardless EUA default history window
export const OVERLAP_DAYS = 7;     // late-booked transactions; import is idempotent so overlap is safe

export function isoAddDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface AccountSyncResult { iban: string; imported: number; skipped: number; error: string | null }
export interface SyncResult { connectionId: string; status: string; accounts: AccountSyncResult[]; proposals: number }

/**
 * Refresh requisition state, pull new transactions per account through the
 * existing import + matching pipeline, advance per-account cursors.
 * Provider (JS-side) failures are caught per account and recorded in last_error;
 * SQL failures abort the surrounding transaction as usual.
 */
export async function syncConnection(
  tx: PoolClient, ctx: TenantContext, provider: BankFeedProvider, connectionId: string, todayIso: string,
): Promise<SyncResult> {
  const conn = await tx.query(
    `SELECT provider_requisition_id AS "requisitionId" FROM bank_feed_connections
     WHERE id = $1 AND client_company_id = $2 FOR UPDATE`,
    [connectionId, ctx.clientCompanyId],
  );
  if (!conn.rowCount) throw new Error('bank feed connection not found');

  const req = await provider.getRequisition(conn.rows[0].requisitionId as string);
  await tx.query(
    `UPDATE bank_feed_connections SET status = $1, consent_expires_at = $2, updated_at = now()
     WHERE id = $3 AND client_company_id = $4`,
    [req.status, req.consentExpiresAt, connectionId, ctx.clientCompanyId],
  );
  if (req.status !== 'linked') {
    await appendAudit(tx, ctx, {
      action: 'sync', entityType: 'bank_feed_connection', entityId: connectionId,
      before: null, after: { status: req.status, accounts: [] },
    });
    return { connectionId, status: req.status, accounts: [], proposals: 0 };
  }

  const accounts = await tx.query(
    `SELECT id, provider_account_id AS "providerAccountId", iban, last_synced_date::text AS "lastSyncedDate"
     FROM bank_feed_accounts WHERE connection_id = $1 AND client_company_id = $2 ORDER BY iban`,
    [connectionId, ctx.clientCompanyId],
  );

  const results: AccountSyncResult[] = [];
  let lastError = '';
  for (const a of accounts.rows) {
    const from = a.lastSyncedDate
      ? isoAddDays(a.lastSyncedDate as string, -OVERLAP_DAYS)
      : isoAddDays(todayIso, -FIRST_SYNC_DAYS);
    try {
      const feed = await provider.fetchTransactions(a.providerAccountId as string, from);
      const stmt: BankStatement = { account: a.iban as string, transactions: feed.map(feedTxnToBankTxn) };
      const r = await importStatement(tx, ctx, stmt);
      await tx.query(`UPDATE bank_feed_accounts SET last_synced_date = $1 WHERE id = $2 AND client_company_id = $3`,
        [todayIso, a.id, ctx.clientCompanyId]);
      results.push({ iban: a.iban as string, imported: r.imported, skipped: r.skipped, error: null });
    } catch (err) {
      // A Postgres error has poisoned the transaction — no further queries can
      // succeed, so fail the whole sync atomically. Provider/network errors
      // (including code-bearing ones like ETIMEDOUT) stay per-account.
      if (err instanceof DatabaseError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      lastError = lastError || `${a.iban}: ${msg}`;
      results.push({ iban: a.iban as string, imported: 0, skipped: 0, error: msg });
    }
  }

  const ar = await proposeMatches(tx, ctx, AR_MATCH);
  const ap = await proposeApMatches(tx, ctx, AP_MATCH);
  await tx.query(
    `UPDATE bank_feed_connections SET last_error = $1, updated_at = now() WHERE id = $2 AND client_company_id = $3`,
    [lastError, connectionId, ctx.clientCompanyId],
  );
  const proposals = ar.proposalIds.length + ap.proposalIds.length;
  await appendAudit(tx, ctx, {
    action: 'sync', entityType: 'bank_feed_connection', entityId: connectionId,
    before: null, after: { status: 'linked', accounts: results, proposals },
  });
  return { connectionId, status: 'linked', accounts: results, proposals };
}

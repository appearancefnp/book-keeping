import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';

export interface JournalEntryListLine {
  accountCode: string;
  accountName: string;
  debit: string;
  credit: string;
  description: string | null;
}

export interface JournalEntryListRow {
  id: string;
  entryDate: string;
  memo: string;
  currency: string;
  reversesEntryId: string | null;
  lines: JournalEntryListLine[];
}

export async function listJournalEntries(
  tx: PoolClient,
  ctx: TenantContext,
  filter: { limit?: number } = {},
): Promise<JournalEntryListRow[]> {
  const res = await tx.query(
    `SELECT e.id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.memo, e.currency,
            e.reverses_entry_id,
            a.code AS account_code, a.name AS account_name,
            l.debit::text AS debit, l.credit::text AS credit, l.description
       FROM (SELECT id FROM journal_entries
              WHERE client_company_id = $1
              ORDER BY entry_date DESC, created_at DESC
              LIMIT $2) sel
       JOIN journal_entries e ON e.id = sel.id
       JOIN journal_lines l ON l.entry_id = e.id
       JOIN accounts a ON a.id = l.account_id
      ORDER BY e.entry_date DESC, e.created_at DESC, e.id, a.code`,
    [ctx.clientCompanyId, filter.limit ?? 50],
  );
  const byId = new Map<string, JournalEntryListRow>();
  for (const r of res.rows) {
    let entry = byId.get(r.id);
    if (!entry) {
      entry = {
        id: r.id,
        entryDate: r.entry_date,
        memo: r.memo,
        currency: r.currency,
        reversesEntryId: r.reverses_entry_id,
        lines: [],
      };
      byId.set(r.id, entry);
    }
    entry.lines.push({
      accountCode: r.account_code,
      accountName: r.account_name,
      debit: r.debit,
      credit: r.credit,
      description: r.description,
    });
  }
  return [...byId.values()];
}

export interface AccountLineRow {
  entryId: string; entryDate: string; memo: string;
  accountCode: string; accountName: string;
  debit: string; credit: string; description: string | null;
}

/** Flat journal lines for the given accounts within [from,to], ordered by account, date, entry. */
export async function listAccountLines(
  tx: PoolClient,
  ctx: TenantContext,
  filter: { from: string; to: string; accountCodes?: string[] },
): Promise<AccountLineRow[]> {
  const codes = filter.accountCodes && filter.accountCodes.length ? filter.accountCodes : null;
  const res = await tx.query(
    `SELECT e.id AS "entryId", to_char(e.entry_date,'YYYY-MM-DD') AS "entryDate", e.memo,
            a.code AS "accountCode", a.name AS "accountName",
            l.debit::text AS debit, l.credit::text AS credit, l.description
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE l.client_company_id = $1
        AND e.entry_date BETWEEN $2::date AND $3::date
        AND ($4::text[] IS NULL OR a.code = ANY($4))
      ORDER BY a.code, e.entry_date, e.created_at, e.id`,
    [ctx.clientCompanyId, filter.from, filter.to, codes],
  );
  return res.rows;
}

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

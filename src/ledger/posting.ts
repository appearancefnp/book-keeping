import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { sumCents } from '../db/money.js';
import { periodStatusFor } from './periods.js';
import { appendAudit } from '../audit/audit.js';

const lineSchema = z.object({
  accountCode: z.string().min(1),
  debit: z.string(),
  credit: z.string(),
  description: z.string().optional(),
});
const entrySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  memo: z.string().min(1),
  currency: z.string().length(3),
  lines: z.array(lineSchema).min(2),
  sourceDocumentId: z.string().uuid().nullable().optional(),
});

export interface NewJournalLine { accountCode: string; debit: string; credit: string; description?: string; }
export interface NewJournalEntry {
  date: string; memo: string; currency: string; lines: NewJournalLine[]; sourceDocumentId?: string | null;
}
export interface JournalEntryRow {
  id: string; entryDate: string; memo: string; currency: string;
  lines: { accountId: string; debit: string; credit: string; description: string | null }[];
}

export async function postEntry(
  tx: PoolClient, ctx: TenantContext, input: NewJournalEntry,
): Promise<{ entryId: string }> {
  const entry = entrySchema.parse(input);

  // 1. Balance check (integer cents).
  const debits = sumCents(entry.lines.map((l) => l.debit));
  const credits = sumCents(entry.lines.map((l) => l.credit));
  if (debits !== credits) {
    throw new Error(`Entry does not balance: debits ${debits} != credits ${credits}`);
  }

  // 2. Period must be open.
  const status = await periodStatusFor(tx, ctx, entry.date);
  if (status !== 'open') {
    throw new Error(`Cannot post into a ${status} period for date ${entry.date}`);
  }

  // 3. Resolve account codes to ids.
  // Defense-in-depth: explicit tenant predicate in addition to RLS (matches the pattern used in periodStatusFor).
  const codes = [...new Set(entry.lines.map((l) => l.accountCode))];
  const accRes = await tx.query(
    'SELECT id, code FROM accounts WHERE code = ANY($1) AND client_company_id = $2',
    [codes, ctx.clientCompanyId],
  );
  const idByCode = new Map<string, string>(accRes.rows.map((r) => [r.code, r.id]));
  for (const code of codes) {
    if (!idByCode.has(code)) throw new Error(`Unknown account code: ${code}`);
  }

  // 4. Insert entry + lines.
  const entryRes = await tx.query(
    `INSERT INTO journal_entries(client_company_id, entry_date, memo, currency, source_document_id)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.clientCompanyId, entry.date, entry.memo, entry.currency, entry.sourceDocumentId ?? null],
  );
  const entryId = entryRes.rows[0].id as string;

  for (const l of entry.lines) {
    await tx.query(
      `INSERT INTO journal_lines(client_company_id, entry_id, account_id, debit, credit, description)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [ctx.clientCompanyId, entryId, idByCode.get(l.accountCode), l.debit, l.credit, l.description ?? null],
    );
  }

  // 5. Audit.
  await appendAudit(tx, ctx, {
    action: 'post', entityType: 'journal_entry', entityId: entryId,
    before: null, after: { memo: entry.memo, date: entry.date, lines: entry.lines },
  });

  return { entryId };
}

export async function getEntry(
  tx: PoolClient, ctx: TenantContext, entryId: string,
): Promise<JournalEntryRow> {
  // Defense-in-depth: explicit tenant predicate in addition to RLS.
  const e = await tx.query(
    'SELECT id, entry_date, memo, currency FROM journal_entries WHERE id = $1 AND client_company_id = $2',
    [entryId, ctx.clientCompanyId],
  );
  if (!e.rowCount) throw new Error(`Entry not found: ${entryId}`);
  const lines = await tx.query(
    `SELECT account_id, debit::text, credit::text, description
     FROM journal_lines WHERE entry_id = $1 AND client_company_id = $2 ORDER BY id`,
    [entryId, ctx.clientCompanyId],
  );
  const row = e.rows[0];
  return {
    id: row.id,
    entryDate: row.entry_date.toISOString().slice(0, 10),
    memo: row.memo,
    currency: row.currency,
    lines: lines.rows.map((l) => ({ accountId: l.account_id, debit: l.debit, credit: l.credit, description: l.description })),
  };
}

import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { accountBalances } from '../ledger/balances.js';
import { listAccountLines } from '../ledger/query.js';
import { toCents, fromCents } from '../db/money.js';

export interface GlLine {
  entryId: string; date: string; memo: string; description: string | null;
  debit: string; credit: string; balance: string; // running debit-normal balance
}
export interface GlAccount {
  code: string; name: string;
  opening: string; lines: GlLine[]; closing: string; // debit-normal
  totalDebit: string; totalCredit: string;
}
export interface GeneralLedger { from: string; to: string; accounts: GlAccount[] }

/** UTC-safe YYYY-MM-DD minus one day. */
function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function generalLedger(
  tx: PoolClient, ctx: TenantContext,
  args: { from: string; to: string; accountCodes?: string[] },
): Promise<GeneralLedger> {
  // Opening = all activity strictly before `from` (debit-normal), per account.
  const opening = await accountBalances(tx, ctx, { to: dayBefore(args.from) });
  const openingByCode = new Map(opening.map((r) => [r.code, r]));

  const lines = await listAccountLines(tx, ctx, args);
  const linesByCode = new Map<string, typeof lines>();
  for (const l of lines) {
    const arr = linesByCode.get(l.accountCode) ?? [];
    arr.push(l);
    linesByCode.set(l.accountCode, arr);
  }

  // Candidate accounts: explicit filter, else accounts with a non-zero opening OR in-range lines.
  const filter = args.accountCodes && args.accountCodes.length ? new Set(args.accountCodes) : null;
  const codes = new Set<string>();
  if (filter) {
    for (const c of filter) codes.add(c);
  } else {
    for (const r of opening) if (toCents(r.balance) !== 0n) codes.add(r.code);
    for (const c of linesByCode.keys()) codes.add(c);
  }

  const accounts: GlAccount[] = [...codes].sort().map((code) => {
    const meta = openingByCode.get(code);
    const openCents = meta ? toCents(meta.balance) : 0n;
    const acctLines = linesByCode.get(code) ?? [];
    let running = openCents;
    let totalDebit = 0n, totalCredit = 0n;
    const glLines: GlLine[] = acctLines.map((l) => {
      running += toCents(l.debit) - toCents(l.credit);
      totalDebit += toCents(l.debit);
      totalCredit += toCents(l.credit);
      return {
        entryId: l.entryId, date: l.entryDate, memo: l.memo, description: l.description,
        debit: l.debit, credit: l.credit, balance: fromCents(running),
      };
    });
    return {
      code, name: meta?.name ?? acctLines[0]?.accountName ?? code,
      opening: fromCents(openCents), lines: glLines, closing: fromCents(running),
      totalDebit: fromCents(totalDebit), totalCredit: fromCents(totalCredit),
    };
  });

  return { from: args.from, to: args.to, accounts };
}

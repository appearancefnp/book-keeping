export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { parseCamt053 } from '@domain/banking/camt-parser.js';
import { importStatement } from '@domain/banking/import.js';
import { proposeApMatches, proposeArMatches, proposeExpenseMatches } from '@domain/banking/match.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

// Accounts for AP-side auto-matching of unmatched bank debits: 5310 payables,
// 2620 bank, 2699 bank-clearing transit (mirrors pay-run settlement accounts).
const AP_MATCH = { payablesAccount: '5310', bankAccount: '2620', bankClearingAccount: '2699' };
// Accounts for AR-side auto-matching of unmatched bank credits: 2310 receivables, 2620 bank.
const AR_MATCH = { receivableAccount: '2310', bankAccount: '2620' };
// Accounts for expense-claim reimbursement auto-matching of unmatched bank debits:
// 5610 employee settlements, 2620 bank.
const EXPENSE_MATCH = { bankAccount: '2620', settlementAccount: '5610' };

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; xml?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.xml) return NextResponse.json({ error: 'missing xml' }, { status: 400 });

  try {
    // Authorize before doing any work (parse/import): a forbidden role must get
    // 403, not leak payload-validation errors first.
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bank.write');

    let stmt;
    try {
      stmt = parseCamt053(body.xml);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `camt.053 parse failed: ${msg}` }, { status: 400 });
    }

    const result = await withTenant(ctx, async (tx) => {
      const imported = await importStatement(tx, ctx, stmt);
      const ap = await proposeApMatches(tx, ctx, AP_MATCH);
      const ar = await proposeArMatches(tx, ctx, AR_MATCH);
      const expense = await proposeExpenseMatches(tx, ctx, EXPENSE_MATCH);
      return { ...imported, apProposals: ap.proposalIds.length, arProposals: ar.proposalIds.length, expenseProposals: expense.proposalIds.length };
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

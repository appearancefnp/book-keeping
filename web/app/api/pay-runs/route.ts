export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { createPayRun, listPayRuns } from '@domain/payables/pay-run.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

// Same accounts as bills (5310 payables); pay-run settlement clears through the
// bank-clearing transit account (2699), later matched to the real bank debit by
// proposeApMatches (bank/import wiring).
const PR_ACCOUNTS = { payablesAccount: '5310', bankClearingAccount: '2699' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const payRuns = await withTenant(ctx, (tx) => listPayRuns(tx, ctx));
    return NextResponse.json({ payRuns }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; billIds?: string[]; paidDate?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.billIds?.length) return NextResponse.json({ error: 'no bills selected' }, { status: 400 });
  const paidDate = body.paidDate ?? new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(paidDate)) return NextResponse.json({ error: 'paidDate must be YYYY-MM-DD' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'payruns.write');
    const result = await withTenant(ctx, (tx) => createPayRun(tx, ctx, { billIds: body.billIds!, paidDate, accounts: PR_ACCOUNTS }));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

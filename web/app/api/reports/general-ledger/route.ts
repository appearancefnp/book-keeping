export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { generalLedger } from '@domain/reports/general-ledger.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';
import { isValidIsoDate } from '@/app/lib/date';

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function firstOfMonthIso(): string { return todayIso().slice(0, 8) + '01'; }

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const from = req.nextUrl.searchParams.get('from') ?? firstOfMonthIso();
  const to = req.nextUrl.searchParams.get('to') ?? todayIso();
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    return NextResponse.json({ error: 'from/to must be YYYY-MM-DD' }, { status: 400 });
  }
  const account = req.nextUrl.searchParams.get('account');
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const report = await withTenant(ctx, (tx) =>
      generalLedger(tx, ctx, { from, to, ...(account ? { accountCodes: [account] } : {}) }));
    return NextResponse.json({ report }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

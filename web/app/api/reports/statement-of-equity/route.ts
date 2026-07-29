export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { statementOfEquity } from '@domain/reports/equity.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';
import { isValidIsoDate } from '@/app/lib/date';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  const today = new Date().toISOString().slice(0, 10);
  const from = req.nextUrl.searchParams.get('from') ?? `${today.slice(0, 8)}01`;
  const to = req.nextUrl.searchParams.get('to') ?? today;
  if (!isValidIsoDate(from) || !isValidIsoDate(to)) {
    return NextResponse.json({ error: 'from/to must be YYYY-MM-DD' }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ error: 'from must be on or before to' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const report = await withTenant(ctx, (tx) => statementOfEquity(tx, ctx, { from, to }));
    return NextResponse.json({ report }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

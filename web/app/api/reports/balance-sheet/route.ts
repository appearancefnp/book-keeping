export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { balanceSheet } from '@domain/reports/balance-sheet.js';
import { comparativeBalanceSheet } from '@domain/reports/comparative.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';
import { isValidIsoDate } from '@/app/lib/date';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  const asOf = req.nextUrl.searchParams.get('asOf') ?? new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(asOf)) {
    return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 });
  }

  const compareAsOf = req.nextUrl.searchParams.get('compareAsOf');
  if (compareAsOf !== null && !isValidIsoDate(compareAsOf)) {
    return NextResponse.json({ error: 'compareAsOf must be YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    if (compareAsOf !== null) {
      const report = await withTenant(ctx, (tx) => comparativeBalanceSheet(tx, ctx, { asOf, comparisonAsOf: compareAsOf }));
      return NextResponse.json({ report, comparative: true }, { status: 200 });
    }
    const report = await withTenant(ctx, (tx) => balanceSheet(tx, ctx, { asOf }));
    return NextResponse.json({ report, comparative: false }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

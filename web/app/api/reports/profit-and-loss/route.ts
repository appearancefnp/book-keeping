export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { profitAndLoss } from '@domain/reports/profit-and-loss.js';
import { comparativeProfitAndLoss } from '@domain/reports/comparative.js';
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

  const compareFrom = req.nextUrl.searchParams.get('compareFrom');
  const compareTo = req.nextUrl.searchParams.get('compareTo');
  const wantCompare = compareFrom !== null && compareTo !== null;
  if (wantCompare && (!isValidIsoDate(compareFrom!) || !isValidIsoDate(compareTo!))) {
    return NextResponse.json({ error: 'compareFrom/compareTo must be YYYY-MM-DD' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    if (wantCompare) {
      const report = await withTenant(ctx, (tx) => comparativeProfitAndLoss(tx, ctx, {
        current: { from, to }, comparison: { from: compareFrom!, to: compareTo! },
      }));
      return NextResponse.json({ report, comparative: true }, { status: 200 });
    }
    const report = await withTenant(ctx, (tx) => profitAndLoss(tx, ctx, { from, to }));
    return NextResponse.json({ report, comparative: false }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

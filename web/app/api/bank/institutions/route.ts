export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { makeBankFeedProvider } from '@domain/bankfeed/factory.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const country = req.nextUrl.searchParams.get('country') ?? 'lv';
  try {
    await resolveTenantContext(token, clientCompanyId, nowUnix());
    const institutions = await makeBankFeedProvider().listInstitutions(country);
    return NextResponse.json({ institutions }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /bank feed provider/.test(msg) ? 502 : errorToStatus(msg);
    return NextResponse.json({ error: msg }, { status });
  }
}

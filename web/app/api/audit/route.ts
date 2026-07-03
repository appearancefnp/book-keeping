export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listAuditLog } from '@domain/collab/audit-view.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) {
    return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const audit = await withTenant(ctx, (tx) => listAuditLog(tx, ctx, {}));
    return NextResponse.json({ audit }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /session/i.test(msg) ? 401 : 403;
    return NextResponse.json({ error: msg }, { status });
  }
}

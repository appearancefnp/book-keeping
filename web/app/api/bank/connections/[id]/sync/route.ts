export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { syncConnection } from '@domain/bankfeed/sync.js';
import { makeBankFeedProvider } from '@domain/bankfeed/factory.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function POST(req: NextRequest, routeCtx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await routeCtx.params;
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bank.write');
    const todayIso = new Date().toISOString().slice(0, 10);
    const result = await withTenant(ctx, (tx) => syncConnection(tx, ctx, makeBankFeedProvider(), id, todayIso));
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /bank feed provider/.test(msg) ? 502 : errorToStatus(msg);
    return NextResponse.json({ error: msg }, { status });
  }
}

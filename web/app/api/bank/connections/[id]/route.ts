export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { deleteConnection } from '@domain/bankfeed/connections.js';
import { makeBankFeedProvider } from '@domain/bankfeed/factory.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function DELETE(req: NextRequest, routeCtx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await routeCtx.params;
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bank.write');
    await withTenant(ctx, (tx) => deleteConnection(tx, ctx, makeBankFeedProvider(), id));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = /bank feed provider/.test(msg) ? 502 : errorToStatus(msg);
    return NextResponse.json({ error: msg }, { status });
  }
}

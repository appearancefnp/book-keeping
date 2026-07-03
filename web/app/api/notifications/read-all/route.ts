export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { markAllRead } from '@domain/collab/notifications.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    await withTenant(ctx, async (tx) => {
      await markAllRead(tx, ctx, ctx.actorId);
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const httpStatus = /session/i.test(msg) ? 401 : 403;
    return NextResponse.json({ error: msg }, { status: httpStatus });
  }
}

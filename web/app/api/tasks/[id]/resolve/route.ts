export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { resolveTask } from '@domain/collab/tasks.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed } from '@/app/lib/authz';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  try {
    const tenantCtx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(tenantCtx.actorRole, 'tasks.write');
    await withTenant(tenantCtx, async (tx) => {
      await resolveTask(tx, tenantCtx, id);
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const httpStatus = /session/i.test(msg) ? 401 : 403;
    return NextResponse.json({ error: msg }, { status: httpStatus });
  }
}

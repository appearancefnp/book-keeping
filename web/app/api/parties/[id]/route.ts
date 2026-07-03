export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { updateParty } from '@domain/parties/parties.js';
import type { PartyKind } from '@domain/parties/parties.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; name?: string; regNo?: string | null; vatNo?: string | null; kind?: PartyKind;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    await withTenant(tctx, (tx) =>
      updateParty(tx, tctx, id, {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.regNo !== undefined && { regNo: body.regNo }),
        ...(body.vatNo !== undefined && { vatNo: body.vatNo }),
        ...(body.kind !== undefined && { kind: body.kind }),
      }),
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listParties, createParty } from '@domain/parties/parties.js';
import type { PartyKind } from '@domain/parties/parties.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const kind = req.nextUrl.searchParams.get('kind') as PartyKind | null;

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const parties = await withTenant(ctx, (tx) => listParties(tx, ctx, kind ? { kind } : {}));
    return NextResponse.json({ parties }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; kind?: PartyKind; name?: string; regNo?: string | null; vatNo?: string | null;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.kind || !body.name) return NextResponse.json({ error: 'missing kind or name' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    const result = await withTenant(ctx, (tx) =>
      createParty(tx, ctx, { kind: body.kind!, name: body.name!, regNo: body.regNo ?? null, vatNo: body.vatNo ?? null }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}

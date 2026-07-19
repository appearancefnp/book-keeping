export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listParties, createParty } from '@domain/parties/parties.js';
import type { PartyKind } from '@domain/parties/parties.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

const PARTY_KINDS: readonly PartyKind[] = ['customer', 'vendor', 'both'];
const isPartyKind = (v: unknown): v is PartyKind => PARTY_KINDS.includes(v as PartyKind);

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const kindParam = req.nextUrl.searchParams.get('kind');
  if (kindParam !== null && !isPartyKind(kindParam)) {
    return NextResponse.json({ error: 'invalid kind' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const parties = await withTenant(ctx, (tx) => listParties(tx, ctx, kindParam ? { kind: kindParam } : {}));
    return NextResponse.json({ parties }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; kind?: PartyKind; name?: string; regNo?: string | null; vatNo?: string | null; paymentTermsDays?: number | null;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.name) return NextResponse.json({ error: 'missing name' }, { status: 400 });
  if (!isPartyKind(body.kind)) return NextResponse.json({ error: 'invalid kind' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'parties.write');
    const result = await withTenant(ctx, (tx) =>
      createParty(tx, ctx, { kind: body.kind!, name: body.name!, regNo: body.regNo ?? null, vatNo: body.vatNo ?? null, paymentTermsDays: body.paymentTermsDays ?? null }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

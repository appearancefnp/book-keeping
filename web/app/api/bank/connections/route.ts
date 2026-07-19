export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { createConnection, listConnections } from '@domain/bankfeed/connections.js';
import { makeBankFeedProvider } from '@domain/bankfeed/factory.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const status = /bank feed provider/.test(msg) ? 502 : errorToStatus(msg);
  return NextResponse.json({ error: msg }, { status });
}

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const connections = await withTenant(ctx, (tx) => listConnections(tx, ctx));
    return NextResponse.json({ connections }, { status: 200 });
  } catch (err) { return fail(err); }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; institutionId?: string; institutionName?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.institutionId) return NextResponse.json({ error: 'missing institutionId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bank.write');
    const connectionId = randomUUID();
    const redirectUrl = `${req.nextUrl.origin}/bank/callback?cid=${connectionId}&client=${encodeURIComponent(body.clientCompanyId)}`;
    const result = await withTenant(ctx, (tx) =>
      createConnection(tx, ctx, makeBankFeedProvider(), {
        connectionId, institutionId: body.institutionId!,
        institutionName: body.institutionName ?? body.institutionId!, redirectUrl,
      }));
    return NextResponse.json(result, { status: 200 });
  } catch (err) { return fail(err); }
}

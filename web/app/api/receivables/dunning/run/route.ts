export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { runDunning } from '@domain/dunning/dunning.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';
import { isValidIsoDate } from '@/app/lib/date';

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; asOf?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const asOf = body.asOf ?? new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(asOf)) return NextResponse.json({ error: 'asOf must be a valid YYYY-MM-DD date' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const summary = await withTenant(ctx, (tx) => runDunning(tx, ctx, { asOf }));
    return NextResponse.json(summary, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

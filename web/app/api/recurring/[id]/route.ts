export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { updateTemplate, deactivateTemplate } from '@domain/recurring/recurring.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

async function resolve(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return null;
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) throw new Error('missing clientCompanyId');
  return resolveTenantContext(token, clientCompanyId, nowUnix());
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await resolve(req);
    if (!ctx) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const { id } = await context.params;
    const patch = (await req.json().catch(() => ({}))) as Parameters<typeof updateTemplate>[3];
    await withTenant(ctx, (tx) => updateTemplate(tx, ctx, id, patch));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await resolve(req);
    if (!ctx) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const { id } = await context.params;
    await withTenant(ctx, (tx) => deactivateTemplate(tx, ctx, id));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

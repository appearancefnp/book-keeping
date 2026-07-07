export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { getInvoiceProfile, setInvoiceProfile, type InvoiceProfile } from '@domain/einvoice/invoice-profile.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const profile = await withTenant(ctx, (tx) => getInvoiceProfile(tx, ctx));
    return NextResponse.json({ profile }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; profile?: InvoiceProfile };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.profile) return NextResponse.json({ error: 'missing profile' }, { status: 400 });
  const p = body.profile;
  // Validate.
  if (p.dueDateOffsetDays !== null && p.dueDateOffsetDays !== undefined &&
      (!Number.isInteger(p.dueDateOffsetDays) || p.dueDateOffsetDays < 0)) {
    return NextResponse.json({ error: 'invalid dueDateOffsetDays' }, { status: 400 });
  }
  if (!Array.isArray(p.defaultLines)) {
    return NextResponse.json({ error: 'invalid defaultLines' }, { status: 400 });
  }
  for (const l of p.defaultLines) {
    if (typeof l?.description !== 'string' || typeof l?.net !== 'string' || typeof l?.vatRate !== 'number') {
      return NextResponse.json({ error: 'invalid default line' }, { status: 400 });
    }
  }
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'invoice_profile.write');
    await withTenant(ctx, (tx) => setInvoiceProfile(tx, ctx, {
      paymentTerms: p.paymentTerms?.trim() || null,
      note: p.note?.trim() || null,
      dueDateOffsetDays: p.dueDateOffsetDays ?? null,
      numberPrefix: p.numberPrefix?.trim() || null,
      defaultLines: p.defaultLines,
    }));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

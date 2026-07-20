export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { saveClaim, listClaims, type NewClaimLine } from '@domain/expenses/claims.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const status = req.nextUrl.searchParams.get('status') ?? undefined;
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    // listClaims self-scopes to the caller's own employee row for client-side roles
    // (employee/owner); firm-side roles (firm_admin/accountant) see every claim.
    const claims = await withTenant(ctx, (tx) => listClaims(tx, ctx, { status }));
    return NextResponse.json({ claims }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; claimId?: string; employeeId?: string | null; description?: string; lines?: NewClaimLine[];
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.description || !body.lines?.length) {
    return NextResponse.json({ error: 'missing description or lines' }, { status: 400 });
  }
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'expenses.write');
    // saveClaim self-scopes: client-side roles (employee/owner) may only save their own claim
    // (resolveClaimEmployee throws otherwise); firm-side roles may pass any employeeId.
    const result = await withTenant(ctx, (tx) => saveClaim(tx, ctx, {
      claimId: body.claimId, employeeId: body.employeeId, description: body.description!, lines: body.lines!,
    }));
    return NextResponse.json(result, { status: body.claimId ? 200 : 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

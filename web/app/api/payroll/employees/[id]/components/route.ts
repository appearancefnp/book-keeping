export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { addPayComponent, type ComponentKind } from '@domain/payroll/inputs.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; year?: number; month?: number; kind?: ComponentKind;
    amount?: string; quantity?: string; reason?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (body.year === undefined || body.month === undefined || !body.kind) {
    return NextResponse.json({ error: 'missing year/month/kind' }, { status: 400 });
  }
  if (!body.reason || !body.reason.trim()) {
    return NextResponse.json({ error: 'a reason is required for a manual adjustment' }, { status: 400 });
  }
  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(tctx.actorRole, 'payroll.write');
    const result = await withTenant(tctx, (tx) => addPayComponent(tx, tctx, {
      employeeId: id, year: body.year!, month: body.month!, kind: body.kind!,
      ...(body.amount !== undefined && { amount: body.amount }),
      ...(body.quantity !== undefined && { quantity: body.quantity }),
      note: body.reason!.trim(),
    }));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

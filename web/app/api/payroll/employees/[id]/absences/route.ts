export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { addAbsence, type AbsenceType } from '@domain/payroll/inputs.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; type?: AbsenceType; dateFrom?: string; dateTo?: string; reason?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.type || !body.dateFrom || !body.dateTo) {
    return NextResponse.json({ error: 'missing type/dateFrom/dateTo' }, { status: 400 });
  }
  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(tctx.actorRole, 'payroll.write');
    const result = await withTenant(tctx, (tx) => addAbsence(tx, tctx, {
      employeeId: id, type: body.type!, dateFrom: body.dateFrom!, dateTo: body.dateTo!,
      ...(body.reason && body.reason.trim() && { note: body.reason.trim() }),
    }));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

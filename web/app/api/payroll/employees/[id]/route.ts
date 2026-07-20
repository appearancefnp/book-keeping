export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { updateEmployee } from '@domain/payroll/employees.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; wage?: string; position?: string; terminatedOn?: string | null;
    userId?: string | null; iban?: string | null;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(tctx.actorRole, 'payroll.write');
    await withTenant(tctx, (tx) => updateEmployee(tx, tctx, id, {
      ...(body.wage !== undefined && { wage: body.wage }),
      ...(body.position !== undefined && { position: body.position }),
      ...(body.terminatedOn !== undefined && { terminatedOn: body.terminatedOn }),
      ...(body.userId !== undefined && { userId: body.userId }),
      ...(body.iban !== undefined && { iban: body.iban }),
    }));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

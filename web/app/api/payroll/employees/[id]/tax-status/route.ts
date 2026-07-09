export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { setMonthlyTaxStatus } from '@domain/payroll/employees.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; year?: number; month?: number;
    taxBookActive?: boolean; dependents?: number; disabilityGroup?: number;
    isPensioner?: boolean; isRepressed?: boolean;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (body.year === undefined || body.month === undefined || body.taxBookActive === undefined) {
    return NextResponse.json({ error: 'missing year/month/taxBookActive' }, { status: 400 });
  }
  try {
    const tctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(tctx.actorRole, 'payroll.write');
    await withTenant(tctx, (tx) => setMonthlyTaxStatus(tx, tctx, id, {
      year: body.year!, month: body.month!, taxBookActive: body.taxBookActive!,
      dependents: body.dependents ?? 0, disabilityGroup: body.disabilityGroup ?? 0,
      isPensioner: body.isPensioner ?? false, isRepressed: body.isRepressed ?? false,
    }));
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

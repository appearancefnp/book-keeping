export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { buildReimbursementOrder } from '@domain/expenses/reimburse.js';
import { appendAudit } from '@domain/audit/audit.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; claimIds?: string[] };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.claimIds?.length) return NextResponse.json({ error: 'missing claimIds' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'expenses.reimburse');
    const result = await withTenant(ctx, async (tx) => {
      const order = await buildReimbursementOrder(tx, ctx, body.claimIds!);
      await appendAudit(tx, ctx, {
        action: 'payment_order.generated', entityType: 'expense_claim', entityId: null,
        before: null, after: { claimIds: body.claimIds, total: order.total },
      });
      return order;
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

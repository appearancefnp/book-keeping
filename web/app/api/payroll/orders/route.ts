export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listOrders, createOrder, type NewOrder, type OrderType } from '@domain/payroll/orders.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

const ORDER_TYPES: readonly OrderType[] = ['hire', 'termination', 'bonus', 'vacation', 'wage_change'];
const isOrderType = (v: unknown): v is OrderType => ORDER_TYPES.includes(v as OrderType);

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const typeParam = req.nextUrl.searchParams.get('orderType');
  if (typeParam !== null && !isOrderType(typeParam)) {
    return NextResponse.json({ error: 'invalid orderType' }, { status: 400 });
  }
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const orders = await withTenant(ctx, (tx) => listOrders(tx, ctx, typeParam ? { orderType: typeParam } : {}));
    return NextResponse.json({ orders }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; order?: NewOrder };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.order) return NextResponse.json({ error: 'missing order' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'payroll.write');
    const result = await withTenant(ctx, (tx) => createOrder(tx, ctx, body.order!));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listBills, createBill, type NewBill } from '@domain/payables/bills.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

// Representative LR chart defaults — accountant to confirm; matches documents/capture.
const AP_ACCOUNTS = { vatInputAccount: '5721', payablesAccount: '5310' };

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const status = req.nextUrl.searchParams.get('status') ?? undefined;
  const vendorPartyId = req.nextUrl.searchParams.get('vendorPartyId') ?? undefined;
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const bills = await withTenant(ctx, (tx) => listBills(tx, ctx, { status, vendorPartyId }));
    return NextResponse.json({ bills }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string } & Partial<NewBill>;
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.vendorPartyId || !body.billNumber || !body.lines?.length) {
    return NextResponse.json({ error: 'missing bill fields' }, { status: 400 });
  }
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bills.write');
    const result = await withTenant(ctx, (tx) => createBill(tx, ctx, {
      vendorPartyId: body.vendorPartyId!, billNumber: body.billNumber!, issueDate: body.issueDate!,
      dueDate: body.dueDate!, currency: body.currency ?? 'EUR', lines: body.lines!, source: 'manual',
    }, AP_ACCOUNTS));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

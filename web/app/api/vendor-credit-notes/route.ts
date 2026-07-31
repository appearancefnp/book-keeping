export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listVendorCreditNotes, createVendorCreditNote, type NewVendorCreditNote } from '@domain/payables/credit-notes.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

// Same LR chart defaults as /api/bills — input VAT 5722, payables 5310. The output-VAT
// account must be the identical GL account bills self-assess into, or a reversed AE/K
// line would never net to zero across the bill/credit-note pair.
const VAT_OUTPUT_ACCOUNT = process.env.BILL_VAT_OUTPUT_ACCOUNT ?? '5721';
const AP_ACCOUNTS = { vatInputAccount: '5722', vatOutputAccount: VAT_OUTPUT_ACCOUNT, payablesAccount: '5310' };

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const status = req.nextUrl.searchParams.get('status') ?? undefined;
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const creditNotes = await withTenant(ctx, (tx) => listVendorCreditNotes(tx, ctx, { status }));
    return NextResponse.json({ creditNotes }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string } & Partial<NewVendorCreditNote>;
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.vendorPartyId || !body.creditNoteNumber || !body.lines?.length) {
    return NextResponse.json({ error: 'missing credit note fields' }, { status: 400 });
  }
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'bills.write');
    const result = await withTenant(ctx, (tx) => createVendorCreditNote(tx, ctx, {
      vendorPartyId: body.vendorPartyId!, creditNoteNumber: body.creditNoteNumber!, issueDate: body.issueDate!,
      currency: body.currency ?? 'EUR', lines: body.lines!, correctedBillNumber: body.correctedBillNumber ?? null, source: 'manual',
    }, AP_ACCOUNTS));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

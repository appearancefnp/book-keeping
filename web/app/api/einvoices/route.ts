export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listEinvoices } from '@domain/einvoice/query.js';
import { sendInvoice } from '@domain/einvoice/outbound.js';
import type { EInvoice } from '@domain/einvoice/ubl.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { accessPoint } from '@/app/lib/access-point';

// Default LV chart-of-accounts codes; override per deployment via env.
const RECEIVABLE_ACCOUNT = process.env.EINVOICE_RECEIVABLE_ACCOUNT ?? '2310';
const SALES_ACCOUNT = process.env.EINVOICE_SALES_ACCOUNT ?? '6110';
const VAT_ACCOUNT = process.env.EINVOICE_VAT_ACCOUNT ?? '5721';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const direction = req.nextUrl.searchParams.get('direction') as 'outbound' | 'inbound' | null;
  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 50;

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const einvoices = await withTenant(ctx, (tx) =>
      listEinvoices(tx, ctx, { ...(direction && { direction }), limit }),
    );
    return NextResponse.json({ einvoices }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string;
    invoice?: EInvoice;
    recipientPeppolId?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.invoice) return NextResponse.json({ error: 'missing invoice' }, { status: 400 });
  if (!body.recipientPeppolId) return NextResponse.json({ error: 'missing recipientPeppolId' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    const result = await withTenant(ctx, (tx) =>
      sendInvoice(tx, ctx, {
        invoice: body.invoice!,
        recipientPeppolId: body.recipientPeppolId!,
        ap: accessPoint,
        receivableAccount: RECEIVABLE_ACCOUNT,
        salesAccount: SALES_ACCOUNT,
        vatAccount: VAT_ACCOUNT,
      }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Validation/posting failures (EN 16931 issues, closed period, missing
    // account) are client-fixable → 400, not 403.
    const httpStatus = /session/i.test(msg) ? 401 : /forbidden|denied|not assigned/i.test(msg) ? 403 : 400;
    return NextResponse.json({ error: msg }, { status: httpStatus });
  }
}

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
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

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
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string;
    invoice?: EInvoice;
    recipientPeppolId?: string;
    customerPartyId?: string;
    dueDate?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.invoice) return NextResponse.json({ error: 'missing invoice' }, { status: 400 });
  if (!body.recipientPeppolId) return NextResponse.json({ error: 'missing recipientPeppolId' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const result = await withTenant(ctx, async (tx) => {
      // Resolve the receivable due date: explicit body.dueDate > invoice.dueDate > customer's
      // payment-terms-days computed from the issue date. sendInvoice itself only falls back to
      // invoice.dueDate, so the terms-based computation must happen here.
      let dueDate = body.dueDate ?? body.invoice!.dueDate ?? null;
      if (!dueDate && body.customerPartyId) {
        const { getParty, dueDateFromTerms } = await import('@domain/parties/parties.js');
        const party = await getParty(tx, ctx, body.customerPartyId);
        if (party.paymentTermsDays != null) {
          dueDate = dueDateFromTerms(body.invoice!.issueDate, party.paymentTermsDays);
        }
      }
      return sendInvoice(tx, ctx, {
        invoice: body.invoice!,
        recipientPeppolId: body.recipientPeppolId!,
        ap: accessPoint,
        receivableAccount: RECEIVABLE_ACCOUNT,
        salesAccount: SALES_ACCOUNT,
        vatAccount: VAT_ACCOUNT,
        customerPartyId: body.customerPartyId ?? null,
        dueDate,
      });
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Validation/posting failures (EN 16931 issues, closed period, missing
    // account) are client-fixable → 400; role/assignment failures → 403.
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

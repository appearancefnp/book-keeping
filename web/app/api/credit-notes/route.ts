export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { sendCreditNote } from '@domain/einvoice/outbound.js';
import type { ECreditNote } from '@domain/einvoice/ubl.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { accessPoint } from '@/app/lib/access-point';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

// Default LV chart-of-accounts codes; override per deployment via env.
const RECEIVABLE_ACCOUNT = process.env.EINVOICE_RECEIVABLE_ACCOUNT ?? '2310';
const SALES_ACCOUNT = process.env.EINVOICE_SALES_ACCOUNT ?? '6110';
const VAT_ACCOUNT = process.env.EINVOICE_VAT_ACCOUNT ?? '5721';

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string;
    creditNote?: ECreditNote;
    recipientPeppolId?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.creditNote) return NextResponse.json({ error: 'missing creditNote' }, { status: 400 });
  if (!body.recipientPeppolId) return NextResponse.json({ error: 'missing recipientPeppolId' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const result = await withTenant(ctx, (tx) =>
      sendCreditNote(tx, ctx, {
        creditNote: body.creditNote!,
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
    // account) are client-fixable → 400; role/assignment failures → 403.
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

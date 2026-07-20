export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { settleReceivable } from '@domain/receivables/settlement.js';
import { voidReceivable } from '@domain/receivables/receivables.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';
import { isValidIsoDate } from '@/app/lib/date';

// Default LV chart-of-accounts codes; override per deployment via env.
const RECEIVABLE_ACCOUNT = process.env.EINVOICE_RECEIVABLE_ACCOUNT ?? '2310';
const BANK_ACCOUNT = process.env.BANK_ACCOUNT ?? '2620';

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await context.params;

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string;
    action?: 'settle' | 'void';
    amountCents?: string;
    paidDate?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (body.action === 'settle' && body.paidDate && !isValidIsoDate(body.paidDate)) {
    return NextResponse.json({ error: 'paidDate must be a valid YYYY-MM-DD date' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'receivables.settle');
    const result = await withTenant(ctx, async (tx) => {
      if (body.action === 'void') {
        await voidReceivable(tx, ctx, id);
        return { voided: true };
      }
      if (body.action === 'settle') {
        if (!body.amountCents || !body.paidDate) throw new Error('settle requires amountCents and paidDate');
        return settleReceivable(tx, ctx, {
          einvoiceId: id,
          amountCents: body.amountCents,
          paidDate: body.paidDate,
          method: 'manual',
          bankAccount: BANK_ACCOUNT,
          receivableAccount: RECEIVABLE_ACCOUNT,
        });
      }
      throw new Error('unknown action');
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

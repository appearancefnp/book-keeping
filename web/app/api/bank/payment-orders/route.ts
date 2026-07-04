export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { generateSepaCreditTransfer } from '@domain/banking/sepa.js';
import { appendAudit } from '@domain/audit/audit.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

interface PaymentIn { iban?: string; amount?: string; reference?: string; }

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; payments?: PaymentIn[] };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const payments = (body.payments ?? []).filter(
    (p): p is { iban: string; amount: string; reference: string } =>
      !!p.iban?.trim() && !!p.amount?.trim() && Number(p.amount) > 0 && p.reference !== undefined,
  );
  if (payments.length === 0) return NextResponse.json({ error: 'no valid payments' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    const xml = generateSepaCreditTransfer(payments);
    await withTenant(ctx, (tx) =>
      appendAudit(tx, ctx, {
        action: 'payment_order.generated',
        entityType: 'payment_order',
        entityId: null,
        before: null,
        after: { count: payments.length, references: payments.map((p) => p.reference) },
      }),
    );
    return NextResponse.json({ xml }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}

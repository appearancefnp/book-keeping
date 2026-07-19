export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@domain/auth/sessions.js';
import { listCurrentTariffsForFirm, setTariff } from '@domain/tariffs/tariffs.js';
import { withTenant, appPool } from '@domain/db/pool.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus, isRoleAllowed } from '@/app/lib/authz';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  if (session.role !== 'accountant' && session.role !== 'firm_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const tariffs = await listCurrentTariffsForFirm(session.firmId, today());
  return NextResponse.json({ tariffs, role: session.role }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  if (!isRoleAllowed(session.role, 'tariffs.write')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; monthlyAmountCents?: string | number;
    currency?: string; vatRate?: string; effectiveFrom?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  let amount: bigint;
  try {
    amount = BigInt(body.monthlyAmountCents ?? '');
    if (amount < 0n) throw new Error('negative');
  } catch {
    return NextResponse.json({ error: 'invalid monthlyAmountCents' }, { status: 400 });
  }
  const currency = (body.currency ?? 'EUR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return NextResponse.json({ error: 'invalid currency' }, { status: 400 });
  if (!body.vatRate || !/^\d+(\.\d+)?$/.test(body.vatRate)) {
    return NextResponse.json({ error: 'invalid vatRate' }, { status: 400 });
  }
  if (!body.effectiveFrom || !/^\d{4}-\d{2}-\d{2}$/.test(body.effectiveFrom)) {
    return NextResponse.json({ error: 'invalid effectiveFrom' }, { status: 400 });
  }

  try {
    // Firm-scoping check: the target client must belong to the admin's firm.
    const check = await appPool.query(
      `SELECT 1 FROM client_companies WHERE id = $1 AND firm_id = $2`,
      [body.clientCompanyId, session.firmId],
    );
    if (!check.rowCount) return NextResponse.json({ error: 'client not in firm' }, { status: 403 });

    const ctx = {
      firmId: session.firmId,
      clientCompanyId: body.clientCompanyId,
      actorId: session.userId,
      actorRole: session.role,
    };
    const result = await withTenant(ctx, (tx) =>
      setTariff(tx, ctx, {
        monthlyAmountCents: amount,
        currency,
        vatRate: body.vatRate!,
        effectiveFrom: body.effectiveFrom!,
      }),
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

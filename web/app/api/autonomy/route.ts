export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listAutonomyPolicies, setAutonomy } from '@domain/autonomy/autonomy.js';
import type { AutonomyMode } from '@domain/autonomy/autonomy.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const policies = await withTenant(ctx, (tx) => listAutonomyPolicies(tx, ctx));
    return NextResponse.json({ policies }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string; operationType?: string; mode?: AutonomyMode; materialThresholdCents?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.operationType?.trim()) return NextResponse.json({ error: 'missing operationType' }, { status: 400 });
  if (body.mode !== 'auto' && body.mode !== 'approval') {
    return NextResponse.json({ error: 'invalid mode' }, { status: 400 });
  }
  let threshold: bigint | undefined;
  if (body.materialThresholdCents !== undefined) {
    try {
      threshold = BigInt(body.materialThresholdCents);
      if (threshold < 0n) throw new Error('negative');
    } catch {
      return NextResponse.json({ error: 'invalid materialThresholdCents' }, { status: 400 });
    }
  }

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'autonomy.write');
    await withTenant(ctx, (tx) =>
      setAutonomy(tx, ctx, {
        operationType: body.operationType!.trim(),
        mode: body.mode!,
        ...(threshold !== undefined && { materialThresholdCents: threshold }),
      }),
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

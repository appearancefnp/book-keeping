export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { getDunningPolicy, setDunningPolicy, listStages, setStages, type Stage } from '@domain/dunning/policy.js';
import { enqueueDunningRun } from '@domain/dunning/schedule.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const result = await withTenant(ctx, async (tx) => ({
      policy: await getDunningPolicy(tx, ctx),
      stages: await listStages(tx, ctx),
    }));
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function PUT(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as {
    clientCompanyId?: string;
    policy?: { enabled: boolean; lateFeeAnnualBps: number; lateFeeFlatCents: string };
    stages?: Stage[];
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.policy || !body.stages) return NextResponse.json({ error: 'missing policy or stages' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'dunning.write');
    await withTenant(ctx, async (tx) => {
      await setDunningPolicy(tx, ctx, body.policy!);
      await setStages(tx, ctx, body.stages!);
      if (body.policy!.enabled) {
        const asOf = new Date().toISOString().slice(0, 10);
        await enqueueDunningRun(tx, ctx, { asOf });
      }
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

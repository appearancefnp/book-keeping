export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { validateSession } from '@domain/auth/sessions.js';
import { listTemplatesForFirm, snapshotClientAsTemplate } from '@domain/onboarding/templates.js';
import { withTenant, appPool } from '@domain/db/pool.js';
import type { TenantContext } from '@domain/tenancy/context.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus, isRoleAllowed } from '@/app/lib/authz';

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  if (session.role !== 'accountant' && session.role !== 'firm_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const templates = await listTemplatesForFirm(session.firmId);
  return NextResponse.json({ templates, role: session.role }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });
  if (!isRoleAllowed(session.role, 'templates.write')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; name?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.name?.trim()) return NextResponse.json({ error: 'missing name' }, { status: 400 });

  try {
    const check = await appPool.query(
      `SELECT 1 FROM client_companies WHERE id = $1 AND firm_id = $2`,
      [body.clientCompanyId, session.firmId],
    );
    if (!check.rowCount) return NextResponse.json({ error: 'client not in firm' }, { status: 403 });

    const ctx: TenantContext = {
      firmId: session.firmId, clientCompanyId: body.clientCompanyId,
      actorId: session.userId, actorRole: session.role,
    };
    const result = await withTenant(ctx, (tx) => snapshotClientAsTemplate(tx, ctx, body.name!.trim()));
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

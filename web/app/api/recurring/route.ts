export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { createTemplate, listTemplates } from '@domain/recurring/recurring.js';
import { enqueueRecurringGenerate, periodKey } from '@domain/recurring/schedule.js';
import { utcMidnight } from '@domain/dunning/schedule.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const activeParam = req.nextUrl.searchParams.get('active');
  const filter = activeParam == null ? {} : { active: activeParam === 'true' };
  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const templates = await withTenant(ctx, (tx) => listTemplates(tx, ctx, filter));
    return NextResponse.json({ templates }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; template?: Record<string, unknown> };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.template) return NextResponse.json({ error: 'missing template' }, { status: 400 });
  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'einvoice.issue');
    const result = await withTenant(ctx, async (tx) => {
      const created = await createTemplate(tx, ctx, body.template as Parameters<typeof createTemplate>[2]);
      const firstRunDate = (body.template as { firstRunDate: string }).firstRunDate;
      await enqueueRecurringGenerate(tx, ctx, { templateId: created.id, period: periodKey(firstRunDate), runAt: utcMidnight(firstRunDate) });
      return created;
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

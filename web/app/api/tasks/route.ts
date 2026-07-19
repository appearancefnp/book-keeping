export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { listTasks, createTask } from '@domain/collab/tasks.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { parsePaging } from '@/app/lib/paging';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  const status = req.nextUrl.searchParams.get('status') as 'open' | 'resolved' | null;
  const paging = parsePaging(req.nextUrl.searchParams);

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const tasks = await withTenant(ctx, async (tx) => {
      return listTasks(tx, ctx, { ...(status && { status }), ...paging });
    });
    return NextResponse.json({ tasks }, { status: 200 });
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
    title?: string;
    detail?: string;
  };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.title) return NextResponse.json({ error: 'missing title' }, { status: 400 });

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'tasks.write');
    const result = await withTenant(ctx, async (tx) => {
      return createTask(tx, ctx, { title: body.title!, detail: body.detail });
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

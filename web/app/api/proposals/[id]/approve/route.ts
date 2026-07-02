export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { approveHandler } from '@domain/api/handlers.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const res = await approveHandler({
    token, clientCompanyId: body.clientCompanyId, params: { id }, atUnixSeconds: nowUnix(),
  });
  return NextResponse.json(res.body, { status: res.status });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { documentsHandler } from '@domain/api/documents-handlers.js';
import type { AuthedRequest } from '@domain/api/types.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const status = req.nextUrl.searchParams.get('status') ?? undefined;
  const authedReq: AuthedRequest = {
    token,
    clientCompanyId,
    params: status ? { status } : {},
    atUnixSeconds: nowUnix(),
  };
  const res = await documentsHandler(authedReq);
  return NextResponse.json(res.body, { status: res.status });
}

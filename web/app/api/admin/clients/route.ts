export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { validateSession } from '@domain/auth/sessions.js';
import { listClientCompaniesForFirm } from '@domain/tenancy/firms.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });

  if (session.role !== 'accountant' && session.role !== 'firm_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const clients = await listClientCompaniesForFirm(session.firmId);
  return NextResponse.json({ clients }, { status: 200 });
}

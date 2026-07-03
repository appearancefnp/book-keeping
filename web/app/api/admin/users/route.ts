export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { validateSession } from '@domain/auth/sessions.js';
import { listUsersForFirm } from '@domain/auth/users.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Invalid or expired session' }, { status: 401 });

  if (session.role !== 'accountant' && session.role !== 'firm_admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const users = await listUsersForFirm(session.firmId);
  return NextResponse.json({ users }, { status: 200 });
}

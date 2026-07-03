export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { validateSession } from '@domain/auth/sessions.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET() {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const session = await validateSession(token, nowUnix());
  if (!session) return NextResponse.json({ error: 'Session invalid or expired' }, { status: 401 });
  return NextResponse.json({ userId: session.userId, firmId: session.firmId, role: session.role }, { status: 200 });
}

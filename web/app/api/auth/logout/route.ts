export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { logout } from '@domain/auth/sessions.js';
import { SESSION_COOKIE, getSessionToken } from '@/app/lib/session';

export async function POST() {
  const token = await getSessionToken();
  if (token) {
    try {
      await logout(token);
    } catch {
      // best-effort — still clear the cookie
    }
  }
  (await cookies()).set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return NextResponse.json({ ok: true }, { status: 200 });
}

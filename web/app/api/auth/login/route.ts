export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { login } from '@domain/auth/sessions.js';
import { SESSION_COOKIE, nowUnix } from '@/app/lib/session';

export async function POST(req: Request) {
  const { email, password, code } = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
    code?: string;
  };
  if (!email || !password || !code)
    return NextResponse.json({ error: 'email, password and code are required' }, { status: 400 });
  try {
    const { sessionToken } = await login(email, password, code, nowUnix());
    (await cookies()).set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 12,
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'login failed';
    return NextResponse.json({ error: msg }, { status: 401 });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { login } from '@domain/auth/sessions.js';
import { checkLoginAllowed, clearLoginFailures, recordLoginFailure } from '@domain/auth/rate-limit.js';
import { SESSION_COOKIE, nowUnix } from '@/app/lib/session';

export async function POST(req: Request) {
  const { email, password, code } = (await req.json().catch(() => ({}))) as {
    email?: string; password?: string; code?: string;
  };
  if (!email || !password || !code)
    return NextResponse.json({ error: 'email, password and code are required' }, { status: 400 });

  const ip = (req.headers.get('x-forwarded-for') ?? 'unknown').split(',')[0]!.trim();
  const identifiers = [`email:${email.toLowerCase()}`, `ip:${ip}`];
  const at = nowUnix();
  if (!(await checkLoginAllowed(identifiers, at))) {
    // Same shape/message as a bad login — no lockout oracle.
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }
  try {
    const { sessionToken } = await login(email, password, code, at);
    await clearLoginFailures(identifiers);
    (await cookies()).set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60 * 12,
    });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e) {
    await recordLoginFailure(identifiers, at);
    const msg = e instanceof Error ? e.message : 'login failed';
    return NextResponse.json({ error: msg }, { status: 401 });
  }
}

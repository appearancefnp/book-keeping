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

  const ip = clientIp(req);
  const identifiers = [`email:${email.toLowerCase()}`, ...(ip ? [`ip:${ip}`] : [])];
  const at = nowUnix();

  let allowed = false;
  try {
    allowed = await checkLoginAllowed(identifiers, at);
  } catch {
    // Fail CLOSED: a limiter-only breakage (e.g. migration drift dropping
    // login_attempts while login still works) must not disable brute-force
    // protection. login() needs the same DB, so legitimate logins lose nothing.
  }
  if (!allowed) {
    // Same shape/message as a bad login — no lockout oracle.
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  let authenticated = false;
  try {
    const { sessionToken } = await login(email, password, code, at);
    authenticated = true;
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
    if (!authenticated) {
      try {
        await recordLoginFailure(identifiers, at);
      } catch {
        // Recording is best-effort: a limiter-storage failure must not block the
        // error response. (Unlike checkLoginAllowed above, nothing here fails open —
        // the next check simply sees one fewer recorded failure.)
      }
    }
    const msg = e instanceof Error ? e.message : 'login failed';
    return NextResponse.json({ error: msg }, { status: 401 });
  }
}

// Trust assumption: on Vercel (the deployment target — see docs/RUNNING.md §3),
// the platform overwrites x-real-ip and x-forwarded-for at its edge, so neither
// is client-suppliable there. Behind any OTHER proxy, re-derive this from the
// proxy's documented behavior before trusting it. The IP identifier is
// defense-in-depth; the per-email limiter never depends on headers.
function clientIp(req: Request): string | null {
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const hops = forwarded.split(',');
    return hops[hops.length - 1]!.trim();
  }
  return null;
}

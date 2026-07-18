export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { previewInvite, acceptInvite } from '@domain/auth/invites.js';
import { checkLoginAllowed, recordLoginFailure } from '@domain/auth/rate-limit.js';
import { nowUnix } from '@/app/lib/session';

// Trusted client IP: x-real-ip (Vercel-set) first, else the LAST x-forwarded-for
// hop (earlier hops are attacker-suppliable), else 'unknown'. Mirrors the login
// route's clientIp helper (hardened after the Task 2 review).
function ipOf(req: NextRequest): string {
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',');
    return hops[hops.length - 1]!.trim();
  }
  return 'unknown';
}

// Limiter calls are guarded and fail CLOSED: a limiter-only breakage must not
// disable token-probing protection (the 404 shape stays generic either way).
// Mirrors the login route's hardened guard.
async function allowed(ids: string[], at: number): Promise<boolean> {
  try { return await checkLoginAllowed(ids, at); } catch { return false; }
}
async function recordFailure(ids: string[], at: number): Promise<void> {
  try { await recordLoginFailure(ids, at); } catch { /* recording is best-effort */ }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const at = nowUnix();
  const ids = [`invite-ip:${ipOf(req)}`];
  if (!(await allowed(ids, at))) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const preview = await previewInvite(token, at);
  if (!preview) {
    await recordFailure(ids, at); // token probing burns the same budget
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json(preview, { status: 200 });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { password?: string; totpCode?: string };
  const at = nowUnix();
  const ids = [`invite-ip:${ipOf(req)}`];
  if (!(await allowed(ids, at))) return NextResponse.json({ error: 'not found' }, { status: 404 });
  try {
    await acceptInvite(token, { password: body.password ?? '', totpCode: body.totpCode ?? '' }, at);
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    await recordFailure(ids, at);
    return NextResponse.json({ error: 'not found' }, { status: 404 }); // generic: invalid = expired = used
  }
}

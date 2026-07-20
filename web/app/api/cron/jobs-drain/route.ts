export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextRequest, NextResponse } from 'next/server';
import '@domain/jobs/register.js'; // side-effect: registers job handlers (dunning_run, ...)
import { drainOnce } from '@domain/jobs/worker.js';
import { reapOnce } from '@domain/jobs/reapers.js';
import { cronAuthorized } from '@/app/lib/cron-auth';

/** Vercel cron entrypoint for the job queue: reap (seed recovery jobs), then drain. */
export async function GET(req: NextRequest) {
  if (!cronAuthorized(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const now = new Date();
    const { seeded } = await reapOnce({ now });
    const { ran, failed } = await drainOnce({ now, leaseTimeoutMs: 5 * 60 * 1000, limit: 20 });
    return NextResponse.json({ seeded, ran, failed }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

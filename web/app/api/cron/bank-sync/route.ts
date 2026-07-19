export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { syncAllClients } from '@domain/bankfeed/cron.js';
import { makeBankFeedProvider } from '@domain/bankfeed/factory.js';

/** Vercel cron entrypoint. Fail closed: no CRON_SECRET configured → always 401. */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await syncAllClients(makeBankFeedProvider(), new Date().toISOString().slice(0, 10));
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

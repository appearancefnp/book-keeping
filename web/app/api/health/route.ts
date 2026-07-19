export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { appPool } from '@domain/db/pool.js';
import { blobConfigStatus } from '@domain/blob/config-status.js';

export async function GET() {
  // Destructured rather than passing process.env wholesale — see comment in
  // src/blob/factory.ts for why (Next.js's ProcessEnv augmentation trips TS2559).
  const { VERCEL_ENV, BLOB_READ_WRITE_TOKEN } = process.env;
  const blob = blobConfigStatus({ VERCEL_ENV, BLOB_READ_WRITE_TOKEN });
  try {
    await appPool.query('SELECT 1');
    return NextResponse.json({ ok: true, blob }, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, blob }, { status: 503 });
  }
}

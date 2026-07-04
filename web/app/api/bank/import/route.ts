export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { parseCamt053 } from '@domain/banking/camt-parser.js';
import { importStatement } from '@domain/banking/import.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; xml?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  if (!body.xml) return NextResponse.json({ error: 'missing xml' }, { status: 400 });

  let stmt;
  try {
    stmt = parseCamt053(body.xml);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `camt.053 parse failed: ${msg}` }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    const result = await withTenant(ctx, (tx) => importStatement(tx, ctx, stmt));
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: /session/i.test(msg) ? 401 : 403 });
  }
}

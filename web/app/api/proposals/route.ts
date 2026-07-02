export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { approvalQueueHandler } from '@domain/api/handlers.js';
import { withTenant } from '@domain/db/pool.js';
import { resolveTenantContext } from '@domain/auth/context.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const res = await approvalQueueHandler({ token, clientCompanyId, atUnixSeconds: nowUnix() });

  if (res.status === 200) {
    const body = res.body as { proposals?: Array<{ id: string; [k: string]: unknown }> };
    if (Array.isArray(body.proposals) && body.proposals.length > 0) {
      try {
        const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
        const ids = body.proposals.map((p) => p.id);
        const result = await withTenant(ctx, (tx) =>
          tx.query<{ id: string; created_at: Date }>(
            'SELECT id, created_at FROM proposals WHERE client_company_id = $1 AND id = ANY($2::uuid[])',
            [clientCompanyId, ids],
          ),
        );
        const tsMap = new Map<string, string>(
          result.rows.map((row) => [row.id, row.created_at.toISOString()]),
        );
        const enriched = body.proposals.map((p) => ({ ...p, createdAt: tsMap.get(p.id) }));
        return NextResponse.json({ ...body, proposals: enriched }, { status: res.status });
      } catch {
        // enrichment failed — return original response unchanged
      }
    }
  }

  return NextResponse.json(res.body, { status: res.status });
}

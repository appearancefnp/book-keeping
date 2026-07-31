export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { getProposal } from '@domain/proposals/proposals.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';

// A filing's generated XML lives on the proposal rationale (createVatDeclarationProposal /
// createEcslProposal both set it), not on the payload.
interface FilingRationale { xml?: string }

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const { id } = await context.params;

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const prop = await withTenant(ctx, (tx) => getProposal(tx, ctx, id));
    if (prop.type !== 'declaration' && prop.type !== 'ecsl') {
      return NextResponse.json({ error: 'not a filing proposal' }, { status: 400 });
    }
    const xml = (prop.rationale as FilingRationale).xml ?? null;

    if (req.nextUrl.searchParams.get('download') === '1') {
      if (!xml) return NextResponse.json({ error: 'filing has no XML' }, { status: 404 });
      const name = prop.type === 'ecsl' ? 'pvn2' : 'pvn-declaration';
      return new NextResponse(xml, {
        status: 200,
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          'Content-Disposition': `attachment; filename="${name}-${id.slice(0, 8)}.xml"`,
        },
      });
    }

    return NextResponse.json({ id: prop.id, type: prop.type, status: prop.status, xml }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

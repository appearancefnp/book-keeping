export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { PoolClient } from 'pg';
import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import type { TenantContext } from '@domain/tenancy/context.js';
import { withTenant } from '@domain/db/pool.js';
import { ecSalesList } from '@domain/tax/ecsl.js';
import { createEcslProposal } from '@domain/tax/ecsl-proposal.js';
import { getVatSettings } from '@domain/tax/vat-settings.js';
import { filingPeriodByLabel, currentFilingPeriod, type FilingPeriod } from '@domain/tax/filing-periods.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

const PERIOD_LABEL_RE = /^\d{4}-(\d{2}|Q[1-4])$/;

async function resolvePeriod(tx: PoolClient, ctx: TenantContext, label: string | null): Promise<FilingPeriod> {
  const { periodicity } = await getVatSettings(tx, ctx);
  return label
    ? filingPeriodByLabel(label, periodicity)
    : currentFilingPeriod(new Date().toISOString().slice(0, 10), periodicity);
}

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const label = req.nextUrl.searchParams.get('period');
  if (label !== null && !PERIOD_LABEL_RE.test(label)) {
    return NextResponse.json({ error: 'invalid period' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const { period, list } = await withTenant(ctx, async (tx) => {
      const period = await resolvePeriod(tx, ctx, label);
      const list = await ecSalesList(tx, ctx, { fromDate: period.fromDate, toDate: period.toDate });
      return { period, list };
    });
    return NextResponse.json({ period, list }, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

export async function POST(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { clientCompanyId?: string; period?: string };
  if (!body.clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  const label = body.period ?? null;
  if (label !== null && !PERIOD_LABEL_RE.test(label)) {
    return NextResponse.json({ error: 'invalid period' }, { status: 400 });
  }

  try {
    const ctx = await resolveTenantContext(token, body.clientCompanyId, nowUnix());
    assertRoleAllowed(ctx.actorRole, 'filings.prepare');
    const { proposalId } = await withTenant(ctx, async (tx) => {
      const period = await resolvePeriod(tx, ctx, label);
      return createEcslProposal(tx, ctx, { fromDate: period.fromDate, toDate: period.toDate });
    });
    return NextResponse.json({ proposalId }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

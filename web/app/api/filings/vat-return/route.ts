export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { PoolClient } from 'pg';
import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import type { TenantContext } from '@domain/tenancy/context.js';
import { withTenant } from '@domain/db/pool.js';
import { assembleVatDeclaration } from '@domain/tax/vat-declaration.js';
import { createVatDeclarationProposal } from '@domain/tax/vat-proposal.js';
import { getVatSettings } from '@domain/tax/vat-settings.js';
import { filingPeriodByLabel, currentFilingPeriod, type FilingPeriod } from '@domain/tax/filing-periods.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { assertRoleAllowed, errorToStatus } from '@/app/lib/authz';

// Representative LR chart defaults — accountant to confirm; matches vat-compute.ts / seed.ts
// and the env vars used by the report export route.
const VAT_CONFIG = {
  outputVatAccount: process.env.VAT_OUTPUT_ACCOUNT ?? '5721',
  inputVatAccount: process.env.VAT_INPUT_ACCOUNT ?? '5722',
};

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
    const { period, declaration } = await withTenant(ctx, async (tx) => {
      const period = await resolvePeriod(tx, ctx, label);
      const declaration = await assembleVatDeclaration(tx, ctx, {
        fromDate: period.fromDate, toDate: period.toDate, config: VAT_CONFIG,
      });
      return { period, declaration };
    });
    return NextResponse.json({ period, declaration }, { status: 200 });
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
      return createVatDeclarationProposal(tx, ctx, { fromDate: period.fromDate, toDate: period.toDate, config: VAT_CONFIG });
    });
    return NextResponse.json({ proposalId }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

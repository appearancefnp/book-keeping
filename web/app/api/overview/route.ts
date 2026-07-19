export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { trialBalance } from '@domain/ledger/balances.js';
import { explainVat } from '@domain/tax/explain.js';
import { outstandingReceivables } from '@domain/banking/sepa.js';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { errorToStatus } from '@/app/lib/authz';

const VAT_CONFIG = { outputVatAccount: '5721', inputVatAccount: '5722' };

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const clientCompanyId = req.nextUrl.searchParams.get('clientCompanyId');
  if (!clientCompanyId) {
    return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });
  }

  // Period defaulting: current calendar year; override with ?from= / ?to=
  const year = new Date().getFullYear();
  const fromDate = req.nextUrl.searchParams.get('from') ?? `${year}-01-01`;
  const toDate = req.nextUrl.searchParams.get('to') ?? `${year}-12-31`;

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const data = await withTenant(ctx, async (tx) => {
      const tb = await trialBalance(tx, ctx);
      const vat = await explainVat(tx, ctx, {
        fromDate,
        toDate,
        config: VAT_CONFIG,
      });
      const rec = await outstandingReceivables(tx, ctx, '2310');
      return {
        trialBalance: tb,
        vat: { netPayable: vat.netPayable, rule: vat.ruleRef },
        receivables: { balanceCents: rec.balanceCents },
        period: { fromDate, toDate },
      };
    });
    return NextResponse.json(data, { status: 200 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

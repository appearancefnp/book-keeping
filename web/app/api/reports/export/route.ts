export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantContext } from '@domain/auth/context.js';
import { withTenant } from '@domain/db/pool.js';
import { profitAndLoss } from '@domain/reports/profit-and-loss.js';
import { balanceSheet } from '@domain/reports/balance-sheet.js';
import { comparativeProfitAndLoss, comparativeBalanceSheet } from '@domain/reports/comparative.js';
import { generalLedger } from '@domain/reports/general-ledger.js';
import { accountBalances } from '@domain/ledger/balances.js';
import { apAging } from '@domain/payables/aging.js';
import {
  profitAndLossTable, comparativeProfitAndLossTable, balanceSheetTable, comparativeBalanceSheetTable,
  generalLedgerTable, trialBalanceTable, apAgingTable, type ReportTable,
} from '@domain/reports/tabular.js';
import { tableToCsv } from '@domain/reports/csv.js';
import { reportDocumentHtml } from '@domain/reports/report-html.js';
import { tableToXlsx } from '@/app/lib/report-xlsx';
import { reportLabels, type ExportLang } from '@/app/lib/report-labels';
import { getSessionToken, nowUnix } from '@/app/lib/session';
import { isValidIsoDate } from '@/app/lib/date';
import { errorToStatus } from '@/app/lib/authz';

const REPORTS = ['pl', 'bs', 'gl', 'trial', 'apaging'] as const;
const FORMATS = ['csv', 'xlsx', 'pdf'] as const;
type ReportKind = (typeof REPORTS)[number];
type Format = (typeof FORMATS)[number];

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function firstOfMonthIso(): string { return todayIso().slice(0, 8) + '01'; }

export async function GET(req: NextRequest) {
  const token = await getSessionToken();
  if (!token) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const clientCompanyId = q.get('clientCompanyId');
  if (!clientCompanyId) return NextResponse.json({ error: 'missing clientCompanyId' }, { status: 400 });

  const report = q.get('report') as ReportKind | null;
  const format = q.get('format') as Format | null;
  if (!report || !REPORTS.includes(report)) return NextResponse.json({ error: 'invalid report' }, { status: 400 });
  if (!format || !FORMATS.includes(format)) return NextResponse.json({ error: 'invalid format' }, { status: 400 });

  const lang = (q.get('lang') ?? 'lv') as ExportLang;
  const from = q.get('from') ?? firstOfMonthIso();
  const to = q.get('to') ?? todayIso();
  const asOf = q.get('asOf') ?? todayIso();
  const compareFrom = q.get('compareFrom');
  const compareTo = q.get('compareTo');
  const compareAsOf = q.get('compareAsOf');
  const account = q.get('account');
  for (const d of [from, to, asOf, compareFrom, compareTo, compareAsOf]) {
    if (d !== null && !isValidIsoDate(d)) return NextResponse.json({ error: 'dates must be YYYY-MM-DD' }, { status: 400 });
  }

  const L = reportLabels(lang);

  try {
    const ctx = await resolveTenantContext(token, clientCompanyId, nowUnix());
    const table: ReportTable = await withTenant(ctx, async (tx) => {
      switch (report) {
        case 'pl':
          if (compareFrom && compareTo) {
            const c = await comparativeProfitAndLoss(tx, ctx, { current: { from, to }, comparison: { from: compareFrom, to: compareTo } });
            return comparativeProfitAndLossTable(c, L);
          }
          return profitAndLossTable(await profitAndLoss(tx, ctx, { from, to }), L, { from, to });
        case 'bs':
          if (compareAsOf) {
            const c = await comparativeBalanceSheet(tx, ctx, { asOf, comparisonAsOf: compareAsOf });
            return comparativeBalanceSheetTable(c, L);
          }
          return balanceSheetTable(await balanceSheet(tx, ctx, { asOf }), L);
        case 'gl':
          return generalLedgerTable(await generalLedger(tx, ctx, { from, to, ...(account ? { accountCodes: [account] } : {}) }), L);
        case 'trial':
          return trialBalanceTable(await accountBalances(tx, ctx, {}), L, asOf);
        case 'apaging':
          return apAgingTable(await apAging(tx, ctx, { asOf }), L);
      }
    });

    const stamp = report === 'bs' || report === 'apaging' || report === 'trial' ? asOf : `${from}_${to}`;
    if (format === 'pdf') {
      const html = reportDocumentHtml(table, { printLabel: L.print });
      return new NextResponse(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (format === 'csv') {
      return new NextResponse(tableToCsv(table), {
        status: 200,
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${report}-${stamp}.csv"` },
      });
    }
    const buf = await tableToXlsx(table);
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'content-disposition': `attachment; filename="${report}-${stamp}.xlsx"`,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: errorToStatus(msg) });
  }
}

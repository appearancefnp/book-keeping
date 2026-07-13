'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import styles from './page.module.css';

interface StatementLine { code: string; name: string; amount: string; }
interface StatementSection { lines: StatementLine[]; subtotal: string; }
interface ProfitAndLoss { from: string | null; to: string | null; income: StatementSection; expense: StatementSection; netProfit: string; }
interface BalanceSheet {
  asOf: string; assets: StatementSection; liabilities: StatementSection; equity: StatementSection;
  currentPeriodResult: string; totalAssets: string; totalLiabilitiesAndEquity: string; balanced: boolean;
}

interface ApAging { asOf: string; current: string; d1_30: string; d31_60: string; d61_90: string; d90plus: string; total: string; }

type Tab = 'pl' | 'bs' | 'apaging';

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function firstOfMonthIso(): string { return todayIso().slice(0, 8) + '01'; }
function fmtMoney(v: string): string {
  return new Intl.NumberFormat('lv-LV', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));
}
function sectionEmpty(s: StatementSection): boolean { return s.lines.length === 0; }

function ReportsInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [tab, setTab] = useState<Tab>('pl');
  const [from, setFrom] = useState(firstOfMonthIso());
  const [to, setTo] = useState(todayIso());
  const [asOf, setAsOf] = useState(todayIso());

  const [pl, setPl] = useState<ProfitAndLoss | null>(null);
  const [bs, setBs] = useState<BalanceSheet | null>(null);
  const [aging, setAging] = useState<ApAging | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!clientCompanyId) return;
    setLoading(true); setError(null);
    try {
      let url: string;
      if (tab === 'pl') url = `/api/reports/profit-and-loss?clientCompanyId=${encodeURIComponent(clientCompanyId)}&from=${from}&to=${to}`;
      else if (tab === 'bs') url = `/api/reports/balance-sheet?clientCompanyId=${encodeURIComponent(clientCompanyId)}&asOf=${asOf}`;
      else url = `/api/reports/ap-aging?clientCompanyId=${encodeURIComponent(clientCompanyId)}&asOf=${asOf}`;
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { report: ProfitAndLoss | BalanceSheet | ApAging };
      if (tab === 'pl') { setPl(data.report as ProfitAndLoss); setBs(null); setAging(null); }
      else if (tab === 'bs') { setBs(data.report as BalanceSheet); setPl(null); setAging(null); }
      else { setAging(data.report as ApAging); setPl(null); setBs(null); }
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [clientCompanyId, tab, from, to, asOf, t]);

  useEffect(() => { load(); }, [load]);

  const setPreset = (preset: 'month' | 'quarter' | 'year') => {
    const now = new Date();
    const y = now.getFullYear();
    if (preset === 'month') { setFrom(firstOfMonthIso()); setTo(todayIso()); }
    else if (preset === 'quarter') {
      const q = Math.floor(now.getMonth() / 3);
      const startMonth = String(q * 3 + 1).padStart(2, '0');
      setFrom(`${y}-${startMonth}-01`); setTo(todayIso());
    } else { setFrom(`${y}-01-01`); setTo(todayIso()); }
  };

  const plIsLoss = useMemo(() => pl != null && Number(pl.netProfit) < 0, [pl]);

  const renderSection = (title: string, s: StatementSection) => (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <table className={styles.table}>
        <tbody>
          {s.lines.map((l, i) => (
            <tr key={`${l.code}-${i}`}>
              <td className={styles.code}>{l.code}</td>
              <td className={styles.name}>{l.code === '' ? t('reports.currentResult') : l.name}</td>
              <td className={styles.amount}>{fmtMoney(l.amount)}</td>
            </tr>
          ))}
          <tr className={styles.subtotalRow}>
            <td /><td className={styles.name}>{title}</td>
            <td className={styles.amount}>{fmtMoney(s.subtotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('reports.title')}</h1>

        <div className={styles.tabs} role="tablist">
          <button role="tab" aria-selected={tab === 'pl'} className={tab === 'pl' ? styles.tabActive : styles.tab} onClick={() => setTab('pl')}>{t('reports.tab.pl')}</button>
          <button role="tab" aria-selected={tab === 'bs'} className={tab === 'bs' ? styles.tabActive : styles.tab} onClick={() => setTab('bs')}>{t('reports.tab.bs')}</button>
          <button role="tab" aria-selected={tab === 'apaging'} className={tab === 'apaging' ? styles.tabActive : styles.tab} onClick={() => setTab('apaging')}>{t('reports.tab.apaging')}</button>
        </div>

        <div className={styles.controls}>
          {tab === 'pl' ? (
            <>
              <label className={styles.field}>{t('reports.from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className={styles.field}>{t('reports.to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
              <div className={styles.presets}>
                <button onClick={() => setPreset('month')}>{t('reports.preset.month')}</button>
                <button onClick={() => setPreset('quarter')}>{t('reports.preset.quarter')}</button>
                <button onClick={() => setPreset('year')}>{t('reports.preset.year')}</button>
              </div>
            </>
          ) : (
            <label className={styles.field}>{t('reports.asOf')}<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
          )}
        </div>

        {error && <ErrorState message={error} onRetry={load} />}
        {!error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}

        {!error && !loading && tab === 'pl' && pl && (
          sectionEmpty(pl.income) && sectionEmpty(pl.expense)
            ? <EmptyState message={t('reports.empty')} detail={t('reports.emptyDetail')} />
            : (
              <div className={styles.statement}>
                {renderSection(t('reports.income'), pl.income)}
                {renderSection(t('reports.expense'), pl.expense)}
                <div className={styles.grandTotal}>
                  <span>{plIsLoss ? t('reports.netLoss') : t('reports.netProfit')}</span>
                  <span className={styles.amount}>{fmtMoney(pl.netProfit)}</span>
                </div>
              </div>
            )
        )}

        {!error && !loading && tab === 'bs' && bs && (
          sectionEmpty(bs.assets) && sectionEmpty(bs.liabilities) && sectionEmpty(bs.equity)
            ? <EmptyState message={t('reports.empty')} detail={t('reports.emptyDetail')} />
            : (
              <div className={styles.statement}>
                {renderSection(t('reports.assets'), bs.assets)}
                {renderSection(t('reports.liabilities'), bs.liabilities)}
                {renderSection(t('reports.equity'), bs.equity)}
                <div className={styles.grandTotal}>
                  <span>{t('reports.totalAssets')}</span><span className={styles.amount}>{fmtMoney(bs.totalAssets)}</span>
                </div>
                <div className={styles.grandTotal}>
                  <span>{t('reports.totalLiabEquity')}</span><span className={styles.amount}>{fmtMoney(bs.totalLiabilitiesAndEquity)}</span>
                </div>
                <div className={bs.balanced ? styles.balanced : styles.unbalanced}>
                  {bs.balanced ? t('reports.balanced') : t('reports.unbalanced')}
                </div>
              </div>
            )
        )}

        {!error && !loading && tab === 'apaging' && aging && (
          <div className={styles.statement}>
            <table className={styles.table}><tbody>
              <tr><td className={styles.name}>{t('reports.aging.current')}</td><td className={styles.amount}>{fmtMoney(aging.current)}</td></tr>
              <tr><td className={styles.name}>{t('reports.aging.d1_30')}</td><td className={styles.amount}>{fmtMoney(aging.d1_30)}</td></tr>
              <tr><td className={styles.name}>{t('reports.aging.d31_60')}</td><td className={styles.amount}>{fmtMoney(aging.d31_60)}</td></tr>
              <tr><td className={styles.name}>{t('reports.aging.d61_90')}</td><td className={styles.amount}>{fmtMoney(aging.d61_90)}</td></tr>
              <tr><td className={styles.name}>{t('reports.aging.d90plus')}</td><td className={styles.amount}>{fmtMoney(aging.d90plus)}</td></tr>
            </tbody></table>
            <div className={styles.grandTotal}><span>{t('reports.aging.total')}</span><span className={styles.amount}>{fmtMoney(aging.total)}</span></div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<SkeletonCard />}>
      <ReportsInner />
    </Suspense>
  );
}

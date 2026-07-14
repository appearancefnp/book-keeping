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

type Tab = 'pl' | 'bs' | 'apaging' | 'araging';

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

  const [dunPolicy, setDunPolicy] = useState<{ enabled: boolean; lateFeeAnnualBps: number; lateFeeFlatCents: string } | null>(null);
  const [dunStages, setDunStages] = useState<{ level: number; daysOverdue: number }[]>([]);
  const [dunMsg, setDunMsg] = useState<string | null>(null);

  const loadDunning = useCallback(async (id: string) => {
    const res = await fetch(`/api/receivables/dunning/policy?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = (await res.json()) as { policy: typeof dunPolicy; stages: typeof dunStages };
    setDunPolicy(data.policy);
    setDunStages(data.stages);
  }, []);

  const saveDunning = useCallback(async () => {
    if (!clientCompanyId || !dunPolicy) return;
    const res = await fetch(`/api/receivables/dunning/policy`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientCompanyId, policy: dunPolicy, stages: dunStages }),
    });
    setDunMsg(res.ok ? t('dunning.saved') : ((await res.json().catch(() => ({}))) as { error?: string }).error ?? t('state.error'));
  }, [clientCompanyId, dunPolicy, dunStages, t]);

  const runDunningNow = useCallback(async () => {
    if (!clientCompanyId) return;
    const res = await fetch(`/api/receivables/dunning/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientCompanyId, asOf }),
    });
    const data = (await res.json().catch(() => ({}))) as { prompted?: number; error?: string };
    setDunMsg(res.ok ? `${t('dunning.ranSummary')} ${data.prompted ?? 0}` : data.error ?? t('state.error'));
  }, [clientCompanyId, asOf, t]);

  const load = useCallback(async () => {
    if (!clientCompanyId) return;
    setLoading(true); setError(null);
    try {
      let url: string;
      if (tab === 'pl') url = `/api/reports/profit-and-loss?clientCompanyId=${encodeURIComponent(clientCompanyId)}&from=${from}&to=${to}`;
      else if (tab === 'bs') url = `/api/reports/balance-sheet?clientCompanyId=${encodeURIComponent(clientCompanyId)}&asOf=${asOf}`;
      else if (tab === 'apaging') url = `/api/reports/ap-aging?clientCompanyId=${encodeURIComponent(clientCompanyId)}&asOf=${asOf}`;
      else url = `/api/reports/ar-aging?clientCompanyId=${encodeURIComponent(clientCompanyId)}&asOf=${asOf}`;
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

  useEffect(() => {
    if (tab === 'araging' && clientCompanyId) loadDunning(clientCompanyId);
  }, [tab, clientCompanyId, loadDunning]);

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
          <button role="tab" aria-selected={tab === 'araging'} className={tab === 'araging' ? styles.tabActive : styles.tab} onClick={() => setTab('araging')}>{t('reports.tab.araging')}</button>
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

        {!error && !loading && tab === 'araging' && aging && (
          <div className={styles.statement}>
            <table className={styles.table}><tbody>
              <tr><td className={styles.name}>{t('reports.aging.current')}</td><td className={styles.amount}>{fmtMoney(aging.current)}</td></tr>
              <tr><td className={styles.name}>{t('reports.aging.d1_30')}</td><td className={styles.amount}>{fmtMoney(aging.d1_30)}</td></tr>
              <tr><td className={styles.name}>{t('reports.aging.d31_60')}</td><td className={styles.amount}>{fmtMoney(aging.d31_60)}</td></tr>
              <tr><td className={styles.name}>{t('reports.aging.d61_90')}</td><td className={styles.amount}>{fmtMoney(aging.d61_90)}</td></tr>
              <tr><td className={styles.name}>{t('reports.aging.d90plus')}</td><td className={styles.amount}>{fmtMoney(aging.d90plus)}</td></tr>
            </tbody></table>
            <div className={styles.grandTotal}><span>{t('reports.aging.totalReceivable')}</span><span className={styles.amount}>{fmtMoney(aging.total)}</span></div>

            {dunPolicy && (
              <section className={styles.dunning}>
                <h3>{t('dunning.heading')}</h3>
                <label>
                  <input type="checkbox" checked={dunPolicy.enabled}
                    onChange={(e) => setDunPolicy({ ...dunPolicy, enabled: e.target.checked })} />
                  {t('dunning.enabled')}
                </label>
                <label>{t('dunning.annualBps')}
                  <input type="number" min={0} value={dunPolicy.lateFeeAnnualBps}
                    onChange={(e) => setDunPolicy({ ...dunPolicy, lateFeeAnnualBps: Number(e.target.value) })} />
                </label>
                <label>{t('dunning.flat')}
                  <input type="text" inputMode="decimal"
                    value={(Number(dunPolicy.lateFeeFlatCents) / 100).toFixed(2)}
                    onChange={(e) => setDunPolicy({ ...dunPolicy, lateFeeFlatCents: String(Math.round(Number(e.target.value.replace(',', '.')) * 100) || 0) })} />
                </label>
                <fieldset>
                  <legend>{t('dunning.stages')}</legend>
                  {dunStages.map((s, i) => (
                    <div key={s.level} className={styles.stageRow}>
                      <span>L{s.level}</span>
                      <input type="number" min={0} value={s.daysOverdue}
                        onChange={(e) => setDunStages(dunStages.map((x, j) => j === i ? { ...x, daysOverdue: Number(e.target.value) } : x))} />
                    </div>
                  ))}
                  <button type="button" onClick={() => setDunStages([...dunStages, { level: (dunStages.at(-1)?.level ?? 0) + 1, daysOverdue: (dunStages.at(-1)?.daysOverdue ?? 0) + 15 }])}>
                    {t('dunning.addStage')}
                  </button>
                </fieldset>
                <div className={styles.dunningActions}>
                  <button type="button" onClick={saveDunning}>{t('dunning.save')}</button>
                  <button type="button" className={styles.primaryBtn} onClick={runDunningNow}>{t('dunning.run')}</button>
                </div>
                {dunMsg && <p className={styles.dunMsg}>{dunMsg}</p>}
              </section>
            )}
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

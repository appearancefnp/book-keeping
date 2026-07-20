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

interface GlLine { entryId: string; date: string; memo: string; description: string | null; debit: string; credit: string; balance: string; }
interface GlAccount { code: string; name: string; opening: string; lines: GlLine[]; closing: string; totalDebit: string; totalCredit: string; }
interface GeneralLedger { from: string; to: string; accounts: GlAccount[]; }
interface TrialRow { code: string; name: string; debit: string; credit: string; balance: string; }

interface ComparativeLine { code: string; name: string; current: string; comparison: string; variance: string; variancePct: string | null; }
interface ComparativeSection { lines: ComparativeLine[]; current: string; comparison: string; variance: string; variancePct: string | null; }
interface ComparativeProfitAndLoss {
  current: { from: string; to: string }; comparison: { from: string; to: string };
  income: ComparativeSection; expense: ComparativeSection; netProfit: ComparativeLine;
}
interface ComparativeBalanceSheet {
  asOf: string; comparisonAsOf: string;
  assets: ComparativeSection; liabilities: ComparativeSection; equity: ComparativeSection;
  currentPeriodResult: ComparativeLine; totalAssets: ComparativeLine; totalLiabilitiesAndEquity: ComparativeLine;
}

type Tab = 'pl' | 'bs' | 'trial' | 'gl' | 'apaging' | 'araging';

function todayIso(): string { return new Date().toISOString().slice(0, 10); }
function firstOfMonthIso(): string { return todayIso().slice(0, 8) + '01'; }
function fmtMoney(v: string): string {
  return new Intl.NumberFormat('lv-LV', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));
}
function fmtPct(v: string | null): string {
  return v === null ? '—' : `${v}%`;
}
function sectionEmpty(s: StatementSection): boolean { return s.lines.length === 0; }
function cmpSectionEmpty(s: ComparativeSection): boolean { return s.lines.length === 0; }

function ReportsInner() {
  const searchParams = useSearchParams();
  const { t, lang } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [tab, setTab] = useState<Tab>('pl');
  const [from, setFrom] = useState(firstOfMonthIso());
  const [to, setTo] = useState(todayIso());
  const [asOf, setAsOf] = useState(todayIso());
  const [compareFrom, setCompareFrom] = useState('');
  const [compareTo, setCompareTo] = useState('');
  const [compareAsOf, setCompareAsOf] = useState('');
  const [glAccount, setGlAccount] = useState('');

  const [pl, setPl] = useState<ProfitAndLoss | null>(null);
  const [plCmp, setPlCmp] = useState<ComparativeProfitAndLoss | null>(null);
  const [bs, setBs] = useState<BalanceSheet | null>(null);
  const [bsCmp, setBsCmp] = useState<ComparativeBalanceSheet | null>(null);
  const [aging, setAging] = useState<ApAging | null>(null);
  const [gl, setGl] = useState<GeneralLedger | null>(null);
  const [trial, setTrial] = useState<TrialRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dunPolicy, setDunPolicy] = useState<{ enabled: boolean; lateFeeAnnualBps: number; lateFeeFlatCents: string } | null>(null);
  const [dunStages, setDunStages] = useState<{ level: number; daysOverdue: number }[]>([]);
  const [dunMsg, setDunMsg] = useState<string | null>(null);
  const [dunFlatDraft, setDunFlatDraft] = useState('');

  const loadDunning = useCallback(async (id: string) => {
    const res = await fetch(`/api/receivables/dunning/policy?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = (await res.json()) as { policy: typeof dunPolicy; stages: typeof dunStages };
    setDunPolicy(data.policy);
    setDunStages(data.stages);
    setDunFlatDraft(data.policy ? (Number(data.policy.lateFeeFlatCents) / 100).toFixed(2) : '');
  }, []);

  const saveDunning = useCallback(async () => {
    if (!clientCompanyId || !dunPolicy) return;
    const parsed = Number(dunFlatDraft.trim().replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed < 0) {
      setDunMsg(t('dunning.invalidFlat'));
      return;
    }
    const policy = { ...dunPolicy, lateFeeFlatCents: String(Math.round(parsed * 100)) };
    const res = await fetch(`/api/receivables/dunning/policy`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientCompanyId, policy, stages: dunStages }),
    });
    setDunMsg(res.ok ? t('dunning.saved') : ((await res.json().catch(() => ({}))) as { error?: string }).error ?? t('state.error'));
  }, [clientCompanyId, dunPolicy, dunStages, dunFlatDraft, t]);

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
      if (tab === 'pl') {
        url = `/api/reports/profit-and-loss?clientCompanyId=${encodeURIComponent(clientCompanyId)}&from=${from}&to=${to}`;
        if (compareFrom && compareTo) url += `&compareFrom=${compareFrom}&compareTo=${compareTo}`;
      } else if (tab === 'bs') {
        url = `/api/reports/balance-sheet?clientCompanyId=${encodeURIComponent(clientCompanyId)}&asOf=${asOf}`;
        if (compareAsOf) url += `&compareAsOf=${compareAsOf}`;
      } else if (tab === 'gl') {
        url = `/api/reports/general-ledger?clientCompanyId=${encodeURIComponent(clientCompanyId)}&from=${from}&to=${to}`;
        if (glAccount) url += `&account=${encodeURIComponent(glAccount)}`;
      } else if (tab === 'trial') {
        url = `/api/reports/trial-balance?clientCompanyId=${encodeURIComponent(clientCompanyId)}`;
      } else if (tab === 'apaging') {
        url = `/api/reports/ap-aging?clientCompanyId=${encodeURIComponent(clientCompanyId)}&asOf=${asOf}`;
      } else {
        url = `/api/reports/ar-aging?clientCompanyId=${encodeURIComponent(clientCompanyId)}&asOf=${asOf}`;
      }
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as {
        report?: ProfitAndLoss | BalanceSheet | ApAging | GeneralLedger | ComparativeProfitAndLoss | ComparativeBalanceSheet;
        rows?: TrialRow[];
        comparative?: boolean;
      };
      setPl(null); setPlCmp(null); setBs(null); setBsCmp(null); setAging(null); setGl(null);
      if (tab === 'pl') {
        if (data.comparative) setPlCmp(data.report as ComparativeProfitAndLoss);
        else setPl(data.report as ProfitAndLoss);
      } else if (tab === 'bs') {
        if (data.comparative) setBsCmp(data.report as ComparativeBalanceSheet);
        else setBs(data.report as BalanceSheet);
      } else if (tab === 'gl') {
        setGl(data.report as GeneralLedger);
      } else if (tab === 'trial') {
        setTrial(data.rows ?? []);
      } else {
        setAging(data.report as ApAging);
      }
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [clientCompanyId, tab, from, to, asOf, compareFrom, compareTo, compareAsOf, glAccount, t]);

  useEffect(() => { load(); }, [load]);

  // Quietly prefetch the trial balance (account list) so the GL tab's account
  // picker is populated even if the user never visits the Trial Balance tab.
  useEffect(() => {
    if (!clientCompanyId || trial !== null || tab !== 'gl') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/reports/trial-balance?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, { cache: 'no-store' });
        if (res.ok && !cancelled) {
          const data = (await res.json()) as { rows: TrialRow[] };
          setTrial(data.rows);
        }
      } catch { /* account picker falls back to no options; report itself still loads */ }
    })();
    return () => { cancelled = true; };
  }, [clientCompanyId, tab, trial]);

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

  const drillToGl = (code: string, glFrom: string, glTo: string) => {
    if (!code) return;
    setGlAccount(code); setFrom(glFrom); setTo(glTo); setTab('gl');
  };

  const plIsLoss = useMemo(() => pl != null && Number(pl.netProfit) < 0, [pl]);

  const exportUrl = useCallback((format: 'csv' | 'xlsx' | 'pdf'): string => {
    const p = new URLSearchParams({ clientCompanyId: clientCompanyId ?? '', report: tab, format, lang });
    if (tab === 'pl' || tab === 'gl') { p.set('from', from); p.set('to', to); }
    if (tab === 'bs' || tab === 'trial' || tab === 'apaging' || tab === 'araging') p.set('asOf', asOf);
    if (tab === 'pl' && compareFrom && compareTo) { p.set('compareFrom', compareFrom); p.set('compareTo', compareTo); }
    if (tab === 'bs' && compareAsOf) p.set('compareAsOf', compareAsOf);
    if (tab === 'gl' && glAccount) p.set('account', glAccount);
    return `/api/reports/export?${p.toString()}`;
  }, [clientCompanyId, tab, lang, from, to, asOf, compareFrom, compareTo, compareAsOf, glAccount]);

  const exportBar = (
    <div className={styles.exportBar}>
      <a className={styles.exportLink} href={exportUrl('csv')} download>{t('export.csv')}</a>
      <a className={styles.exportLink} href={exportUrl('xlsx')} download>{t('export.excel')}</a>
      <a className={styles.exportLink} href={exportUrl('pdf')} target="_blank" rel="noopener noreferrer">{t('export.pdf')}</a>
    </div>
  );

  const renderSection = (title: string, s: StatementSection, onDrill: (code: string) => void) => (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <table className={styles.table}>
        <tbody>
          {s.lines.map((l, i) => (
            <tr key={`${l.code}-${i}`}>
              <td className={styles.code}>
                {l.code === '' ? l.code : (
                  <button type="button" className={styles.codeLink} onClick={() => onDrill(l.code)}>{l.code}</button>
                )}
              </td>
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

  const renderComparativeSection = (title: string, s: ComparativeSection, onDrill: (code: string) => void) => (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>{title}</h3>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" className={styles.code} />
              <th scope="col" className={styles.name} />
              <th scope="col" className={styles.amount}>{t('reports.col.current')}</th>
              <th scope="col" className={styles.amount}>{t('reports.col.comparison')}</th>
              <th scope="col" className={styles.amount}>{t('reports.col.variance')}</th>
              <th scope="col" className={styles.amount}>{t('reports.col.variancePct')}</th>
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l, i) => (
              <tr key={`${l.code}-${i}`}>
                <td className={styles.code}>
                  {l.code === '' ? l.code : (
                    <button type="button" className={styles.codeLink} onClick={() => onDrill(l.code)}>{l.code}</button>
                  )}
                </td>
                <td className={styles.name}>{l.code === '' ? t('reports.currentResult') : l.name}</td>
                <td className={styles.amount}>{fmtMoney(l.current)}</td>
                <td className={styles.amount}>{fmtMoney(l.comparison)}</td>
                <td className={styles.amount}>{fmtMoney(l.variance)}</td>
                <td className={styles.amount}>{fmtPct(l.variancePct)}</td>
              </tr>
            ))}
            <tr className={styles.subtotalRow}>
              <td /><td className={styles.name}>{title}</td>
              <td className={styles.amount}>{fmtMoney(s.current)}</td>
              <td className={styles.amount}>{fmtMoney(s.comparison)}</td>
              <td className={styles.amount}>{fmtMoney(s.variance)}</td>
              <td className={styles.amount}>{fmtPct(s.variancePct)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderComparativeTotal = (label: string, l: ComparativeLine) => (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <tbody>
          <tr className={styles.grandTotalRow}>
            <td className={styles.name}>{label}</td>
            <td className={styles.amount}>{fmtMoney(l.current)}</td>
            <td className={styles.amount}>{fmtMoney(l.comparison)}</td>
            <td className={styles.amount}>{fmtMoney(l.variance)}</td>
            <td className={styles.amount}>{fmtPct(l.variancePct)}</td>
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
          <button role="tab" aria-selected={tab === 'trial'} className={tab === 'trial' ? styles.tabActive : styles.tab} onClick={() => setTab('trial')}>{t('reports.tab.trial')}</button>
          <button role="tab" aria-selected={tab === 'gl'} className={tab === 'gl' ? styles.tabActive : styles.tab} onClick={() => setTab('gl')}>{t('reports.tab.gl')}</button>
          <button role="tab" aria-selected={tab === 'apaging'} className={tab === 'apaging' ? styles.tabActive : styles.tab} onClick={() => setTab('apaging')}>{t('reports.tab.apaging')}</button>
          <button role="tab" aria-selected={tab === 'araging'} className={tab === 'araging' ? styles.tabActive : styles.tab} onClick={() => setTab('araging')}>{t('reports.tab.araging')}</button>
        </div>

        {tab !== 'trial' && (
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
                <label className={styles.field}>{t('reports.compareFrom')}<input type="date" value={compareFrom} onChange={(e) => setCompareFrom(e.target.value)} /></label>
                <label className={styles.field}>{t('reports.compareTo')}<input type="date" value={compareTo} onChange={(e) => setCompareTo(e.target.value)} /></label>
              </>
            ) : tab === 'bs' ? (
              <>
                <label className={styles.field}>{t('reports.asOf')}<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
                <label className={styles.field}>{t('reports.compareAsOf')}<input type="date" value={compareAsOf} onChange={(e) => setCompareAsOf(e.target.value)} /></label>
              </>
            ) : tab === 'gl' ? (
              <>
                <label className={styles.field}>
                  {t('reports.gl.account')}
                  <select value={glAccount} onChange={(e) => setGlAccount(e.target.value)}>
                    <option value="">{t('reports.gl.allAccounts')}</option>
                    {(trial ?? []).map((r) => (
                      <option key={r.code} value={r.code}>{r.code} — {r.name}</option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>{t('reports.from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
                <label className={styles.field}>{t('reports.to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
              </>
            ) : (
              <label className={styles.field}>{t('reports.asOf')}<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
            )}
          </div>
        )}

        {error && <ErrorState message={error} onRetry={load} />}
        {!error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}

        {!error && !loading && clientCompanyId && (
          (tab === 'pl' && (pl || plCmp)) ||
          (tab === 'bs' && (bs || bsCmp)) ||
          (tab === 'trial' && trial) ||
          (tab === 'gl' && gl) ||
          (tab === 'apaging' && aging) ||
          (tab === 'araging' && aging)
        ) && exportBar}

        {!error && !loading && tab === 'pl' && pl && (
          sectionEmpty(pl.income) && sectionEmpty(pl.expense)
            ? <EmptyState message={t('reports.empty')} detail={t('reports.emptyDetail')} />
            : (
              <div className={styles.statement}>
                {renderSection(t('reports.income'), pl.income, (code) => drillToGl(code, from, to))}
                {renderSection(t('reports.expense'), pl.expense, (code) => drillToGl(code, from, to))}
                <div className={styles.grandTotal}>
                  <span>{plIsLoss ? t('reports.netLoss') : t('reports.netProfit')}</span>
                  <span className={styles.amount}>{fmtMoney(pl.netProfit)}</span>
                </div>
              </div>
            )
        )}

        {!error && !loading && tab === 'pl' && plCmp && (
          cmpSectionEmpty(plCmp.income) && cmpSectionEmpty(plCmp.expense)
            ? <EmptyState message={t('reports.empty')} detail={t('reports.emptyDetail')} />
            : (
              <div className={styles.statement}>
                {renderComparativeSection(t('reports.income'), plCmp.income, (code) => drillToGl(code, plCmp.current.from, plCmp.current.to))}
                {renderComparativeSection(t('reports.expense'), plCmp.expense, (code) => drillToGl(code, plCmp.current.from, plCmp.current.to))}
                {renderComparativeTotal(Number(plCmp.netProfit.current) < 0 ? t('reports.netLoss') : t('reports.netProfit'), plCmp.netProfit)}
              </div>
            )
        )}

        {!error && !loading && tab === 'bs' && bs && (
          sectionEmpty(bs.assets) && sectionEmpty(bs.liabilities) && sectionEmpty(bs.equity)
            ? <EmptyState message={t('reports.empty')} detail={t('reports.emptyDetail')} />
            : (
              <div className={styles.statement}>
                {renderSection(t('reports.assets'), bs.assets, (code) => drillToGl(code, `${asOf.slice(0, 4)}-01-01`, asOf))}
                {renderSection(t('reports.liabilities'), bs.liabilities, (code) => drillToGl(code, `${asOf.slice(0, 4)}-01-01`, asOf))}
                {renderSection(t('reports.equity'), bs.equity, (code) => drillToGl(code, `${asOf.slice(0, 4)}-01-01`, asOf))}
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

        {!error && !loading && tab === 'bs' && bsCmp && (
          cmpSectionEmpty(bsCmp.assets) && cmpSectionEmpty(bsCmp.liabilities) && cmpSectionEmpty(bsCmp.equity)
            ? <EmptyState message={t('reports.empty')} detail={t('reports.emptyDetail')} />
            : (
              <div className={styles.statement}>
                {renderComparativeSection(t('reports.assets'), bsCmp.assets, (code) => drillToGl(code, `${bsCmp.asOf.slice(0, 4)}-01-01`, bsCmp.asOf))}
                {renderComparativeSection(t('reports.liabilities'), bsCmp.liabilities, (code) => drillToGl(code, `${bsCmp.asOf.slice(0, 4)}-01-01`, bsCmp.asOf))}
                {renderComparativeSection(t('reports.equity'), bsCmp.equity, (code) => drillToGl(code, `${bsCmp.asOf.slice(0, 4)}-01-01`, bsCmp.asOf))}
                {renderComparativeTotal(t('reports.totalAssets'), bsCmp.totalAssets)}
                {renderComparativeTotal(t('reports.totalLiabEquity'), bsCmp.totalLiabilitiesAndEquity)}
              </div>
            )
        )}

        {!error && !loading && tab === 'trial' && trial && (
          trial.length === 0
            ? <EmptyState message={t('reports.empty')} detail={t('reports.emptyDetail')} />
            : (
              <div className={styles.statement}>
                <div className={styles.tableWrapper}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col" className={styles.code}>{t('reports.col.code')}</th>
                        <th scope="col" className={styles.name}>{t('reports.col.name')}</th>
                        <th scope="col" className={styles.amount}>{t('reports.col.debit')}</th>
                        <th scope="col" className={styles.amount}>{t('reports.col.credit')}</th>
                        <th scope="col" className={styles.amount}>{t('reports.col.balance')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trial.map((r) => (
                        <tr key={r.code}>
                          <td className={styles.code}>
                            <button type="button" className={styles.codeLink} onClick={() => drillToGl(r.code, `${todayIso().slice(0, 4)}-01-01`, todayIso())}>{r.code}</button>
                          </td>
                          <td className={styles.name}>{r.name}</td>
                          <td className={styles.amount}>{fmtMoney(r.debit)}</td>
                          <td className={styles.amount}>{fmtMoney(r.credit)}</td>
                          <td className={styles.amount}>{fmtMoney(r.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )
        )}

        {!error && !loading && tab === 'gl' && gl && (
          gl.accounts.length === 0
            ? <EmptyState message={t('reports.empty')} detail={t('reports.emptyDetail')} />
            : (
              <div className={styles.statement}>
                {gl.accounts.map((a) => (
                  <div key={a.code} className={styles.section}>
                    <h3 className={styles.sectionTitle}>{a.code} — {a.name}</h3>
                    <div className={styles.tableWrapper}>
                      <table className={styles.table}>
                        <thead>
                          <tr>
                            <th scope="col">{t('reports.col.date')}</th>
                            <th scope="col">{t('reports.col.memo')}</th>
                            <th scope="col">{t('reports.col.description')}</th>
                            <th scope="col" className={styles.amount}>{t('reports.col.debit')}</th>
                            <th scope="col" className={styles.amount}>{t('reports.col.credit')}</th>
                            <th scope="col" className={styles.amount}>{t('reports.gl.running')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr className={styles.subtotalRow}>
                            <td colSpan={5} className={styles.name}>{t('reports.gl.opening')}</td>
                            <td className={styles.amount}>{fmtMoney(a.opening)}</td>
                          </tr>
                          {a.lines.map((l, i) => (
                            <tr key={`${l.entryId}-${i}`}>
                              <td>{l.date}</td>
                              <td>{l.memo}</td>
                              <td>{l.description ?? ''}</td>
                              <td className={styles.amount}>{fmtMoney(l.debit)}</td>
                              <td className={styles.amount}>{fmtMoney(l.credit)}</td>
                              <td className={styles.amount}>{fmtMoney(l.balance)}</td>
                            </tr>
                          ))}
                          <tr className={styles.subtotalRow}>
                            <td colSpan={3} className={styles.name}>{t('reports.gl.closing')}</td>
                            <td className={styles.amount}>{fmtMoney(a.totalDebit)}</td>
                            <td className={styles.amount}>{fmtMoney(a.totalCredit)}</td>
                            <td className={styles.amount}>{fmtMoney(a.closing)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
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
                    value={dunFlatDraft}
                    onChange={(e) => setDunFlatDraft(e.target.value)} />
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

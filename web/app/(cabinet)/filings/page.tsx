'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import styles from './page.module.css';

type Periodicity = 'monthly' | 'quarterly';
interface VatSettings { vatNo: string | null; periodicity: Periodicity; }
interface FilingPeriod { label: string; fromDate: string; toDate: string; dueDate: string; }

interface VatCategoryRow {
  category: string;
  salesNetCents: string; salesVatCents: string;
  purchaseNetCents: string; purchaseVatCents: string;
  selfAssessedVatCents: string;
}
interface VatDeclaration {
  outputVat: string; inputVat: string; netPayable: string;
  breakdown: { rows: VatCategoryRow[] };
  /**
   * False means postings reached a VAT account without a document behind them (typically a
   * manual journal entry) — surfaced so the operator can look into it, never treated as a
   * failure of the filing itself.
   */
  reconciles: boolean;
}

interface EcslRow {
  countryCode: string; vatNo: string; supplyType: 'goods' | 'services';
  netCents: string; documentCount: number;
}
interface EcSalesList { rows: EcslRow[]; totalNetCents: string; issues: string[]; }

type Tab = 'vatreturn' | 'ecsl';

function fmtMoney(v: string): string {
  return new Intl.NumberFormat('lv-LV', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));
}
/** Convert an integer-cents string (as returned by the breakdown/ECSL rows) to a formatted display string. */
function fmtCents(v: string): string {
  const n = BigInt(v);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return fmtMoney(`${neg ? '-' : ''}${whole}.${frac}`);
}
function pad(n: number): string { return String(n).padStart(2, '0'); }
function defaultPeriod(periodicity: Periodicity): { year: number; label: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return periodicity === 'monthly'
    ? { year: y, label: `${y}-${pad(m)}` }
    : { year: y, label: `${y}-Q${Math.floor((m - 1) / 3) + 1}` };
}

function FilingsInner() {
  const searchParams = useSearchParams();
  const { t, lang } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [tab, setTab] = useState<Tab>('vatreturn');

  const [settings, setSettings] = useState<VatSettings | null>(null);
  const [vatNoDraft, setVatNoDraft] = useState('');
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);

  const [year, setYear] = useState<number>(() => new Date().getFullYear());
  const [periodLabel, setPeriodLabel] = useState<string>('');

  const [vatReturnData, setVatReturnData] = useState<{ period: FilingPeriod; declaration: VatDeclaration } | null>(null);
  const [ecslData, setEcslData] = useState<{ period: FilingPeriod; list: EcSalesList } | null>(null);
  const [prepared, setPrepared] = useState<{ vatreturn: string | null; ecsl: string | null }>({ vatreturn: null, ecsl: null });

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const periodicity: Periodicity = settings?.periodicity ?? 'monthly';

  const loadSettings = useCallback(async () => {
    if (!clientCompanyId) return;
    try {
      const res = await fetch(`/api/vat-settings?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { settings: VatSettings };
      setSettings(data.settings);
      setVatNoDraft(data.settings.vatNo ?? '');
      setPeriodLabel((prev) => {
        if (prev) return prev;
        const d = defaultPeriod(data.settings.periodicity);
        setYear(d.year);
        return d.label;
      });
    } catch (err) {
      // periodLabel never gets set on failure, which would otherwise leave load() below
      // permanently gated (its guard clause requires periodLabel) and the page silently blank.
      setError((err as Error).message ?? t('state.error'));
    }
  }, [clientCompanyId, t]);

  useEffect(() => { loadSettings(); }, [loadSettings]);

  const load = useCallback(async () => {
    if (!clientCompanyId || !periodLabel) return;
    setLoading(true); setError(null);
    try {
      const path = tab === 'vatreturn' ? 'vat-return' : 'ecsl';
      const res = await fetch(
        `/api/filings/${path}?clientCompanyId=${encodeURIComponent(clientCompanyId)}&period=${encodeURIComponent(periodLabel)}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      if (tab === 'vatreturn') {
        setVatReturnData((await res.json()) as { period: FilingPeriod; declaration: VatDeclaration });
      } else {
        setEcslData((await res.json()) as { period: FilingPeriod; list: EcSalesList });
      }
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [clientCompanyId, tab, periodLabel, t]);

  useEffect(() => { load(); }, [load]);

  // A previous "prepared" confirmation refers to a specific period; once the period changes
  // it no longer applies to what's on screen.
  useEffect(() => { setPrepared({ vatreturn: null, ecsl: null }); }, [periodLabel]);

  const periodOptions = useMemo(() => {
    if (periodicity === 'monthly') {
      return Array.from({ length: 12 }, (_, i) => ({
        value: `${year}-${pad(i + 1)}`,
        text: new Intl.DateTimeFormat(LOCALE_FOR[lang], { month: 'long' }).format(new Date(Date.UTC(year, i, 1))),
      }));
    }
    return Array.from({ length: 4 }, (_, i) => ({ value: `${year}-Q${i + 1}`, text: `Q${i + 1}` }));
  }, [periodicity, year, lang]);

  const shiftYear = (delta: number) => {
    const nextYear = year + delta;
    setYear(nextYear);
    setPeriodLabel((prev) => `${nextYear}-${prev.slice(5)}`);
  };

  // Periodicity must be persisted before a period label of the new shape ('YYYY-MM' vs
  // 'YYYY-Qn') can be resolved server-side, so this saves immediately rather than waiting on
  // a separate "save" click — otherwise the picker could offer a period the server would reject.
  const changePeriodicity = async (next: Periodicity) => {
    if (!clientCompanyId) return;
    setBusy(true); setError(null); setSettingsMsg(null);
    try {
      const res = await fetch('/api/vat-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, vatNo: vatNoDraft || null, periodicity: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setSettings({ vatNo: vatNoDraft || null, periodicity: next });
      const d = defaultPeriod(next);
      setYear(d.year);
      setPeriodLabel(d.label);
      setSettingsMsg(t('settings.saved'));
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setBusy(false);
    }
  };

  const saveVatNo = async () => {
    if (!clientCompanyId || !settings) return;
    setBusy(true); setError(null); setSettingsMsg(null);
    try {
      const res = await fetch('/api/vat-settings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, vatNo: vatNoDraft || null, periodicity: settings.periodicity }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setSettings({ ...settings, vatNo: vatNoDraft || null });
      setSettingsMsg(t('settings.saved'));
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setBusy(false);
    }
  };

  const prepare = async () => {
    if (!clientCompanyId || !periodLabel) return;
    setBusy(true); setError(null);
    try {
      const path = tab === 'vatreturn' ? 'vat-return' : 'ecsl';
      const res = await fetch(`/api/filings/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, period: periodLabel }),
      });
      const body = (await res.json().catch(() => ({}))) as { proposalId?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setPrepared((p) => ({ ...p, [tab]: body.proposalId ?? null }));
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setBusy(false);
    }
  };

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

  const exportUrl = useCallback((format: 'csv' | 'xlsx' | 'pdf'): string => {
    const period = tab === 'vatreturn' ? vatReturnData?.period : ecslData?.period;
    const p = new URLSearchParams({
      clientCompanyId: clientCompanyId ?? '',
      report: tab,
      format,
      lang,
      from: period?.fromDate ?? '',
      to: period?.toDate ?? '',
    });
    return `/api/reports/export?${p.toString()}`;
  }, [clientCompanyId, tab, lang, vatReturnData, ecslData]);

  const q = clientCompanyId ? `?client=${encodeURIComponent(clientCompanyId)}` : '';
  const currentPeriod = tab === 'vatreturn' ? vatReturnData?.period : ecslData?.period;

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('filings.title')}</h1>

        <div className={styles.tabs} role="tablist">
          <button role="tab" aria-selected={tab === 'vatreturn'} className={tab === 'vatreturn' ? styles.tabActive : styles.tab} onClick={() => setTab('vatreturn')}>
            {t('filings.tab.vatreturn')}
          </button>
          <button role="tab" aria-selected={tab === 'ecsl'} className={tab === 'ecsl' ? styles.tabActive : styles.tab} onClick={() => setTab('ecsl')}>
            {t('filings.tab.ecsl')}
          </button>
        </div>

        <div className={styles.controls}>
          <div className={styles.yearStepper}>
            <button type="button" onClick={() => shiftYear(-1)} aria-label={t('settings.year')}>&lsaquo;</button>
            <span className={styles.yearValue}>{year}</span>
            <button type="button" onClick={() => shiftYear(1)} aria-label={t('settings.year')}>&rsaquo;</button>
          </div>
          <label className={styles.field}>
            {t('filings.period')}
            <select value={periodLabel} onChange={(e) => setPeriodLabel(e.target.value)}>
              {periodOptions.map((o) => <option key={o.value} value={o.value}>{o.text}</option>)}
            </select>
          </label>
          {currentPeriod && (
            <div className={styles.field}>
              {t('filings.due')}
              <span>{fmtDate(currentPeriod.dueDate)}</span>
            </div>
          )}
        </div>

        <section className={styles.settingsSection}>
          <h3 className={styles.sectionTitle}>{t('filings.settings')}</h3>
          <div className={styles.settingsRow}>
            <label className={styles.field}>
              {t('filings.vatNo')}
              <input type="text" value={vatNoDraft} onChange={(e) => setVatNoDraft(e.target.value)} />
            </label>
            <button type="button" onClick={saveVatNo} disabled={busy || !settings}>{t('filings.save')}</button>
            <label className={styles.field}>
              {t('filings.periodicity')}
              <select value={periodicity} onChange={(e) => changePeriodicity(e.target.value as Periodicity)} disabled={busy}>
                <option value="monthly">{t('filings.periodicity.monthly')}</option>
                <option value="quarterly">{t('filings.periodicity.quarterly')}</option>
              </select>
            </label>
          </div>
          {settingsMsg && <p className={styles.settingsMsg}>{settingsMsg}</p>}
        </section>

        {error && <ErrorState message={error} onRetry={load} />}
        {!error && loading && <div className={styles.skeletons}><SkeletonCard /></div>}

        {!error && !loading && clientCompanyId && (vatReturnData || ecslData) && (
          <div className={styles.exportBar}>
            <a className={styles.exportLink} href={exportUrl('csv')} download>{t('export.csv')}</a>
            <a className={styles.exportLink} href={exportUrl('xlsx')} download>{t('export.excel')}</a>
            <a className={styles.exportLink} href={exportUrl('pdf')} target="_blank" rel="noopener noreferrer">{t('export.pdf')}</a>
          </div>
        )}

        {!error && !loading && tab === 'vatreturn' && vatReturnData && (
          <div className={styles.statement}>
            <table className={styles.table}>
              <tbody>
                <tr><td className={styles.name}>{t('filings.outputVat')}</td><td className={styles.amount}>{fmtMoney(vatReturnData.declaration.outputVat)}</td></tr>
                <tr><td className={styles.name}>{t('filings.inputVat')}</td><td className={styles.amount}>{fmtMoney(vatReturnData.declaration.inputVat)}</td></tr>
              </tbody>
            </table>
            <div className={styles.grandTotal}>
              <span>{t('filings.netPayable')}</span><span className={styles.amount}>{fmtMoney(vatReturnData.declaration.netPayable)}</span>
            </div>

            {vatReturnData.declaration.breakdown.rows.length === 0 ? (
              <EmptyState message={t('reports.empty')} detail={t('reports.emptyDetail')} />
            ) : (
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">{t('filings.col.category')}</th>
                      <th scope="col" className={styles.amount}>{t('filings.col.salesNet')}</th>
                      <th scope="col" className={styles.amount}>{t('filings.col.salesVat')}</th>
                      <th scope="col" className={styles.amount}>{t('filings.col.purchaseNet')}</th>
                      <th scope="col" className={styles.amount}>{t('filings.col.purchaseVat')}</th>
                      <th scope="col" className={styles.amount}>{t('filings.col.selfAssessedVat')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vatReturnData.declaration.breakdown.rows.map((r, i) => (
                      <tr key={`${r.category}-${i}`}>
                        <td>{r.category}</td>
                        <td className={styles.amount}>{fmtCents(r.salesNetCents)}</td>
                        <td className={styles.amount}>{fmtCents(r.salesVatCents)}</td>
                        <td className={styles.amount}>{fmtCents(r.purchaseNetCents)}</td>
                        <td className={styles.amount}>{fmtCents(r.purchaseVatCents)}</td>
                        <td className={styles.amount}>{fmtCents(r.selfAssessedVatCents)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* reconciles === false means postings reached a VAT account without a document behind
                them (typically a manual journal entry) — worth investigating, not a failure. */}
            <div className={vatReturnData.declaration.reconciles ? styles.balanced : styles.unbalanced}>
              {t(vatReturnData.declaration.reconciles ? 'filings.reconciled' : 'filings.notReconciled')}
            </div>

            <div className={styles.actions}>
              <button type="button" onClick={prepare} disabled={busy}>{t('filings.prepare')}</button>
              {prepared.vatreturn && (
                <p className={styles.preparedMsg}>{t('filings.prepared')} — <Link href={`/${q}`}>{t('nav.queue')}</Link></p>
              )}
            </div>
          </div>
        )}

        {!error && !loading && tab === 'ecsl' && ecslData && (
          <div className={styles.statement}>
            {ecslData.list.rows.length === 0 && ecslData.list.issues.length === 0 ? (
              <EmptyState message={t('reports.empty')} detail={t('reports.emptyDetail')} />
            ) : (
              <>
                {ecslData.list.rows.length > 0 && (
                  <div className={styles.tableWrapper}>
                    <table className={styles.table}>
                      <thead>
                        <tr>
                          <th scope="col">{t('filings.col.country')}</th>
                          <th scope="col">{t('filings.col.vatNo')}</th>
                          <th scope="col">{t('filings.col.supplyType')}</th>
                          <th scope="col" className={styles.amount}>{t('filings.col.invoices')}</th>
                          <th scope="col" className={styles.amount}>{t('reports.col.amount')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {ecslData.list.rows.map((r, i) => (
                          <tr key={`${r.countryCode}-${r.vatNo}-${r.supplyType}-${i}`}>
                            <td>{r.countryCode}</td>
                            <td>{r.vatNo}</td>
                            <td>{r.supplyType === 'goods' ? t('filings.goods') : t('filings.services')}</td>
                            <td className={styles.amount}>{r.documentCount}</td>
                            <td className={styles.amount}>{fmtCents(r.netCents)}</td>
                          </tr>
                        ))}
                        <tr className={styles.subtotalRow}>
                          <td /><td /><td className={styles.name}>{t('filings.total')}</td>
                          <td />
                          <td className={styles.amount}>{fmtCents(ecslData.list.totalNetCents)}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}

                {/* These are the supplies VID will reject outright (no linked customer, or a
                    customer with no VAT number) — surfaced prominently so they can't be missed. */}
                {ecslData.list.issues.length > 0 && (
                  <div className={styles.unbalanced}>
                    <h3 className={styles.issuesHeading}>{t('filings.issues')}</h3>
                    <ul className={styles.issuesList}>
                      {ecslData.list.issues.map((issue, i) => <li key={i}>{issue}</li>)}
                    </ul>
                  </div>
                )}
              </>
            )}

            <div className={styles.actions}>
              <button type="button" onClick={prepare} disabled={busy}>{t('filings.prepare')}</button>
              {prepared.ecsl && (
                <p className={styles.preparedMsg}>{t('filings.prepared')} — <Link href={`/${q}`}>{t('nav.queue')}</Link></p>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function FilingsPage() {
  return (
    <Suspense fallback={<SkeletonCard />}>
      <FilingsInner />
    </Suspense>
  );
}

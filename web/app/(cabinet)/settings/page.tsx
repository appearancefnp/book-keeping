'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import type { MsgKey } from '@/app/lib/i18n';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { formatCents } from '@/app/lib/format';
import styles from './page.module.css';

interface PeriodRow { year: number; month: number; status: 'open' | 'closed'; }
interface PolicyRow { operationType: string; mode: 'auto' | 'approval'; materialThresholdCents: string; }

const KNOWN_OPS = ['posting', 'bank_match', 'declaration'] as const;

function SettingsInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [periods, setPeriods] = useState<PeriodRow[] | null>(null);
  const [policies, setPolicies] = useState<PolicyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newYear, setNewYear] = useState(() => String(new Date().getFullYear()));
  const [newMonth, setNewMonth] = useState(() => String(new Date().getMonth() + 1));
  const [newOp, setNewOp] = useState('posting');
  const [newMode, setNewMode] = useState<'auto' | 'approval'>('approval');
  const [newThresholdEur, setNewThresholdEur] = useState('1000');

  const load = useCallback(async (id: string) => {
    setError(null);
    try {
      const [pRes, aRes] = await Promise.all([
        fetch(`/api/periods?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' }),
        fetch(`/api/autonomy?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' }),
      ]);
      if (!pRes.ok) throw new Error(((await pRes.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${pRes.status}`);
      if (!aRes.ok) throw new Error(((await aRes.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${aRes.status}`);
      setPeriods(((await pRes.json()) as { periods: PeriodRow[] }).periods);
      setPolicies(((await aRes.json()) as { policies: PolicyRow[] }).policies);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  async function post(url: string, body: Record<string, unknown>) {
    if (!clientCompanyId) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, ...body }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await load(clientCompanyId);
    } catch (err) {
      setActionError((err as Error).message ?? t('state.error'));
    } finally {
      setBusy(false);
    }
  }

  const opLabel = (op: string) => {
    const key = `settings.op.${op}` as MsgKey;
    const label = t(key);
    return label === key ? op : label;
  };

  if (error) {
    return (
      <div className={styles.page}><main className={styles.main}>
        <ErrorState message={error} onRetry={() => clientCompanyId && load(clientCompanyId)} />
      </main></div>
    );
  }
  if (!periods || !policies) {
    return (
      <div className={styles.page}><main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main></div>
    );
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('settings.title')}</h1>
        {actionError && <p className={styles.formError} role="alert">{actionError}</p>}

        <section className={styles.card} aria-labelledby="periods-heading">
          <h2 id="periods-heading" className={styles.sectionHeading}>{t('settings.periods')}</h2>
          <p className={styles.hint}>{t('settings.periodsHint')}</p>
          {periods.length === 0 && <p className={styles.hint}>{t('settings.periodsEmpty')}</p>}
          {periods.length > 0 && (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t('settings.period')}</th>
                    <th scope="col">{t('settings.periodStatus')}</th>
                    <th scope="col"><span className="sr-only">{t('settings.closePeriod')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={`${p.year}-${p.month}`}>
                      <td className={styles.mono}>{p.year}-{String(p.month).padStart(2, '0')}</td>
                      <td>{p.status === 'open' ? t('settings.period.open') : t('settings.period.closed')}</td>
                      <td className={styles.actionsCell}>
                        <button
                          type="button"
                          className={styles.ghostBtn}
                          disabled={busy}
                          onClick={() => post('/api/periods', { year: p.year, month: p.month, action: p.status === 'open' ? 'close' : 'open' })}
                        >
                          {p.status === 'open' ? t('settings.closePeriod') : t('settings.reopenPeriod')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form
            className={styles.inlineForm}
            onSubmit={(e) => { e.preventDefault(); post('/api/periods', { year: Number(newYear), month: Number(newMonth), action: 'open' }); }}
          >
            <label className={styles.field}>
              <span>{t('settings.year')}</span>
              <input inputMode="numeric" value={newYear} onChange={(e) => setNewYear(e.target.value)} />
            </label>
            <label className={styles.field}>
              <span>{t('settings.month')}</span>
              <input inputMode="numeric" value={newMonth} onChange={(e) => setNewMonth(e.target.value)} />
            </label>
            <button type="submit" className={styles.primaryBtn} disabled={busy}>{t('settings.openPeriod')}</button>
          </form>
        </section>

        <section className={styles.card} aria-labelledby="autonomy-heading">
          <h2 id="autonomy-heading" className={styles.sectionHeading}>{t('settings.autonomy')}</h2>
          <p className={styles.hint}>{t('settings.autonomyHint')}</p>
          {policies.length === 0 && <p className={styles.hint}>{t('settings.autonomyEmpty')}</p>}
          {policies.length > 0 && (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t('settings.operation')}</th>
                    <th scope="col">{t('settings.mode')}</th>
                    <th scope="col" className={styles.colAmount}>{t('settings.threshold')}</th>
                    <th scope="col"><span className="sr-only">{t('settings.mode')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((p) => (
                    <tr key={p.operationType}>
                      <td>{opLabel(p.operationType)}</td>
                      <td>{p.mode === 'auto' ? t('settings.mode.auto') : t('settings.mode.approval')}</td>
                      <td className={styles.colAmount}>{formatCents(p.materialThresholdCents) ?? '—'}</td>
                      <td className={styles.actionsCell}>
                        <button
                          type="button"
                          className={styles.ghostBtn}
                          disabled={busy}
                          onClick={() => post('/api/autonomy', {
                            operationType: p.operationType,
                            mode: p.mode === 'auto' ? 'approval' : 'auto',
                            materialThresholdCents: p.materialThresholdCents,
                          })}
                        >
                          {p.mode === 'auto' ? t('settings.mode.approval') : t('settings.mode.auto')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form
            className={styles.inlineForm}
            onSubmit={(e) => {
              e.preventDefault();
              const eur = Number(newThresholdEur);
              post('/api/autonomy', {
                operationType: newOp,
                mode: newMode,
                ...(Number.isFinite(eur) && eur >= 0 && { materialThresholdCents: String(Math.round(eur * 100)) }),
              });
            }}
          >
            <label className={styles.field}>
              <span>{t('settings.operation')}</span>
              <select value={newOp} onChange={(e) => setNewOp(e.target.value)}>
                {KNOWN_OPS.map((op) => <option key={op} value={op}>{opLabel(op)}</option>)}
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('settings.mode')}</span>
              <select value={newMode} onChange={(e) => setNewMode(e.target.value as 'auto' | 'approval')}>
                <option value="approval">{t('settings.mode.approval')}</option>
                <option value="auto">{t('settings.mode.auto')}</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('settings.threshold')} (EUR)</span>
              <input inputMode="decimal" value={newThresholdEur} onChange={(e) => setNewThresholdEur(e.target.value)} />
            </label>
            <button type="submit" className={styles.primaryBtn} disabled={busy}>{t('settings.addPolicy')}</button>
          </form>
        </section>
      </main>
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<SettingsSkeleton />}>
      <SettingsInner />
    </Suspense>
  );
}

'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { PayrollTabs } from '../PayrollTabs';
import styles from '../payroll.module.css';

interface RunRow { id: string; year: number; month: number; status: 'draft' | 'computed' | 'approved'; }

function RunsInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const client = searchParams.get('client');

  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = new Date();
  const [period, setPeriod] = useState(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`);

  const load = useCallback(async (cid: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/payroll/runs?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setRuns((await res.json()).runs);
    } catch (err) { setError((err as Error).message); } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (client) load(client); }, [client, load]);

  async function openMonth() {
    if (!client) return;
    setError(null);
    const [year, month] = period.split('-').map(Number);
    try {
      const res = await fetch('/api/payroll/runs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, year, month }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      await load(client);
    } catch (err) { setError((err as Error).message); }
  }

  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{t('pay.run.title')}</h1>
        </div>
        <PayrollTabs client={client} />
        {!client && <EmptyState message={t('pay.selectClient')} />}

        {client && (
          <form className={styles.form} onSubmit={(e) => { e.preventDefault(); openMonth(); }}>
            <label className={styles.field}><span>{t('pay.run.period')}</span>
              <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required /></label>
            <div className={styles.formActions}><button className={styles.primaryBtn} type="submit">{t('pay.run.open')}</button></div>
          </form>
        )}

        {client && error && <ErrorState message={error} onRetry={() => load(client)} />}
        {client && !error && loading && <div className={styles.skeletons}><SkeletonCard /></div>}
        {client && !error && !loading && runs && runs.length === 0 && (
          <EmptyState message={t('pay.run.empty')} detail={t('pay.run.emptyDetail')} />
        )}
        {client && !error && !loading && runs && runs.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead><tr>
                <th scope="col">{t('pay.run.period')}</th><th scope="col">{t('pay.run.status')}</th>
                <th scope="col"><span className="sr-only">{t('pay.emp.open')}</span></th>
              </tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className={styles.mono}>{r.year}-{String(r.month).padStart(2, '0')}</td>
                    <td><span className={styles.statusChip}>{t(`pay.run.status.${r.status}` as never)}</span></td>
                    <td className={styles.actionsCell}>
                      <Link className={styles.ghostBtn} href={`/payroll/runs/${r.id}?client=${encodeURIComponent(client)}`}>{t('pay.emp.open')}</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className={styles.skeletons}><SkeletonCard /></div>}><RunsInner /></Suspense>;
}

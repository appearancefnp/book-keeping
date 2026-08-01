'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { formatCents } from '@/app/lib/format';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import styles from './page.module.css';

interface BillRow { id: string; vendorName: string; billNumber: string; dueDate: string; currency: string; outstandingCents: string; }

function PayInner() {
  const { t, lang } = useMessages();
  const client = useSearchParams().get('client');
  const [bills, setBills] = useState<BillRow[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [paidDate, setPaidDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setError(null); setBills(null);
    try {
      const [open, partial] = await Promise.all([
        fetch(`/api/bills?clientCompanyId=${encodeURIComponent(client)}&status=open`, { cache: 'no-store' }).then((r) => r.json()),
        fetch(`/api/bills?clientCompanyId=${encodeURIComponent(client)}&status=partially_paid`, { cache: 'no-store' }).then((r) => r.json()),
      ]);
      setBills([...(open.bills ?? []), ...(partial.bills ?? [])]);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    }
  }, [client, t]);
  useEffect(() => { load(); }, [load]);

  const toggle = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const generate = useCallback(async () => {
    if (!client || sel.size === 0) return;
    setError(null);
    try {
      const res = await fetch('/api/pay-runs', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, billIds: [...sel], paidDate }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { payRunId: string };
      setRunId(data.payRunId);
      setSel(new Set());
      load();
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    }
  }, [client, sel, paidDate, load, t]);

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <h1 className={styles.pageHeading}>{t('payrun.title')}</h1>
        {error && <ErrorState message={error} onRetry={load} />}
        {runId && (
          <div className={styles.done}>
            {t('payrun.done')}{' '}
            <a href={`/api/pay-runs/${runId}?clientCompanyId=${encodeURIComponent(client!)}`}>{t('payrun.download')}</a>
          </div>
        )}
        {!error && !bills && <SkeletonCard />}
        {!error && bills && bills.length === 0 && <EmptyState message={t('payrun.none')} />}
        {!error && bills && bills.length > 0 && (
          <>
            <p className={styles.select}>{t('payrun.select')}</p>
            <label className={styles.field}>{t('payrun.paidDate')}
              <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
            </label>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col" />
                  <th scope="col">{t('bills.vendor')}</th>
                  <th scope="col">{t('bills.number')}</th>
                  <th scope="col">{t('bills.dueDate')}</th>
                  <th scope="col" className={styles.right}>{t('bills.outstanding')}</th>
                </tr>
              </thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id}>
                    <td><input type="checkbox" checked={sel.has(b.id)} onChange={() => toggle(b.id)} /></td>
                    <td>{b.vendorName}</td>
                    <td>{b.billNumber}</td>
                    <td>{fmtDate(b.dueDate)}</td>
                    <td className={styles.right}>{formatCents(b.outstandingCents, b.currency) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button type="button" className={styles.generate} disabled={sel.size === 0} onClick={generate}>
              {t('payrun.generate')}
            </button>
          </>
        )}
      </section>
    </div>
  );
}

export default function PayRunPage() {
  return <Suspense fallback={<SkeletonCard />}><PayInner /></Suspense>;
}

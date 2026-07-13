'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import type { MsgKey } from '@/app/lib/i18n';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { formatCents } from '@/app/lib/format';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import styles from './page.module.css';

interface BillRow {
  id: string; vendorName: string; billNumber: string; dueDate: string; currency: string;
  grandTotalCents: string; outstandingCents: string; status: string;
}

function BillsInner() {
  const { t, lang } = useMessages();
  const params = useSearchParams();
  const client = params.get('client');
  const [bills, setBills] = useState<BillRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!client) return;
    setError(null);
    setBills(null);
    try {
      const res = await fetch(`/api/bills?clientCompanyId=${encodeURIComponent(client)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { bills: BillRow[] };
      setBills(body.bills);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    }
  }, [client, t]);

  useEffect(() => { load(); }, [load]);

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

  // Status values are constrained by the bills.status DB CHECK; fall back to the raw value defensively.
  const statusLabel = (s: string) => {
    const key = `bills.status.${s}` as MsgKey;
    const label = t(key);
    return label === key ? s : label;
  };

  const q = client ? `?client=${encodeURIComponent(client)}` : '';

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.header}>
          <h1 className={styles.pageHeading}>{t('bills.title')}</h1>
          <div className={styles.actions}>
            <Link className={styles.payButton} href={`/bills/pay${q}`}>{t('bills.pay')}</Link>
            <Link className={styles.newButton} href={`/bills/new${q}`}>{t('bills.new')}</Link>
          </div>
        </div>
        {error && <ErrorState message={error} onRetry={load} />}
        {!error && !bills && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}
        {!error && bills && bills.length === 0 && (
          <EmptyState message={t('bills.empty')} detail={t('bills.emptyDetail')} />
        )}
        {!error && bills && bills.length > 0 && (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{t('bills.vendor')}</th>
                <th scope="col">{t('bills.number')}</th>
                <th scope="col">{t('bills.dueDate')}</th>
                <th scope="col" className={styles.right}>{t('bills.outstanding')}</th>
                <th scope="col">{t('bills.status')}</th>
              </tr>
            </thead>
            <tbody>
              {bills.map((b) => (
                <tr key={b.id}>
                  <td><Link href={`/bills/${b.id}${q}`}>{b.vendorName}</Link></td>
                  <td>{b.billNumber}</td>
                  <td>{fmtDate(b.dueDate)}</td>
                  <td className={styles.right}>{formatCents(b.outstandingCents, b.currency) ?? '—'}</td>
                  <td>{statusLabel(b.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}

export default function BillsPage() {
  return (
    <Suspense fallback={<SkeletonCard />}>
      <BillsInner />
    </Suspense>
  );
}

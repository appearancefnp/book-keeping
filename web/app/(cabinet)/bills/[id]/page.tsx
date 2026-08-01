'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import type { MsgKey } from '@/app/lib/i18n';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { formatCents } from '@/app/lib/format';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import styles from './page.module.css';

interface BillDetail {
  id: string; vendorName: string; billNumber: string; issueDate: string; dueDate: string; currency: string;
  netCents: string; vatCents: string; grandTotalCents: string; outstandingCents: string; status: string;
  lines: { lineNo: number; description: string; expenseAccount: string; netCents: string; vatRate: string; vatCents: string }[];
}

function DetailInner() {
  const { t, lang } = useMessages();
  const router = useRouter();
  const id = useParams<{ id: string }>().id;
  const client = useSearchParams().get('client');
  const [bill, setBill] = useState<BillDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);

  const load = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      const res = await fetch(`/api/bills/${id}?clientCompanyId=${encodeURIComponent(client)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { bill: BillDetail };
      setBill(body.bill);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    }
  }, [client, id, t]);

  useEffect(() => { load(); }, [load]);

  const voidBill = useCallback(async () => {
    if (!client) return;
    setVoiding(true);
    try {
      const res = await fetch(`/api/bills/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, action: 'void' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      router.push(`/bills?client=${encodeURIComponent(client)}`);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
      setVoiding(false);
    }
  }, [client, id, router, t]);

  // Status values are constrained by the bills.status DB CHECK; fall back to the raw value defensively.
  const statusLabel = (s: string) => {
    const key = `bills.status.${s}` as MsgKey;
    const label = t(key);
    return label === key ? s : label;
  };

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

  if (error) return <div className={styles.page}><section className={styles.main}><ErrorState message={error} onRetry={load} /></section></div>;
  if (!bill) return <div className={styles.page}><section className={styles.main}><SkeletonCard /></section></div>;

  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <h1 className={styles.pageHeading}>{bill.vendorName} · {bill.billNumber}</h1>
        <dl className={styles.meta}>
          <div><dt>{t('bills.issueDate')}</dt><dd>{fmtDate(bill.issueDate)}</dd></div>
          <div><dt>{t('bills.dueDate')}</dt><dd>{fmtDate(bill.dueDate)}</dd></div>
          <div><dt>{t('bills.status')}</dt><dd>{statusLabel(bill.status)}</dd></div>
          <div><dt>{t('bills.outstanding')}</dt><dd>{formatCents(bill.outstandingCents, bill.currency) ?? '—'}</dd></div>
        </dl>
        <h2 className={styles.h2}>{t('bills.lines')}</h2>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('bills.description')}</th>
              <th scope="col">{t('bills.account')}</th>
              <th scope="col" className={styles.right}>{t('bills.net')}</th>
              <th scope="col" className={styles.right}>{t('bills.vat')}</th>
            </tr>
          </thead>
          <tbody>
            {bill.lines.map((l) => (
              <tr key={l.lineNo}>
                <td>{l.description}</td>
                <td>{l.expenseAccount}</td>
                <td className={styles.right}>{formatCents(l.netCents, bill.currency) ?? '—'}</td>
                <td className={styles.right}>{formatCents(l.vatCents, bill.currency) ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {bill.status === 'awaiting_approval' && (
          <button type="button" className={styles.void} disabled={voiding} onClick={voidBill}>
            {t('bills.void')}
          </button>
        )}
      </section>
    </div>
  );
}

function BillDetailSkeleton() {
  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <SkeletonCard />
      </section>
    </div>
  );
}

export default function BillDetailPage() {
  return (
    <Suspense fallback={<BillDetailSkeleton />}>
      <DetailInner />
    </Suspense>
  );
}

'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import type { MsgKey } from '@/app/lib/i18n';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { formatCents } from '@/app/lib/format';
import styles from './page.module.css';

interface EinvoiceRow {
  id: string; direction: 'outbound' | 'inbound'; invoiceNumber: string; issueDate: string;
  grandTotalCents: string; currency: string; peppolStatus: string; peppolMessageId: string | null;
  vidStatus: string; vidDueDate: string | null;
  docType: 'invoice' | 'credit_note'; correctedInvoiceNumber: string | null;
}

function InvoicesInner() {
  const searchParams = useSearchParams();
  const { t, lang } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [rows, setRows] = useState<EinvoiceRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/einvoices?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { einvoices: EinvoiceRow[] };
      setRows(body.einvoices);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

  // Status keys are constrained by DB CHECKs; fall back to the raw value defensively.
  const statusLabel = (s: string) => {
    const key = `einv.status.${s}` as MsgKey;
    const label = t(key);
    return label === key ? s : label;
  };

  const docTypeLabel = (r: EinvoiceRow) => {
    if (r.docType === 'credit_note') {
      return r.correctedInvoiceNumber
        ? t('einv.docType.credits').replace('{number}', r.correctedInvoiceNumber)
        : t('einv.docType.creditNote');
    }
    return t('einv.docType.invoice');
  };

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{t('einv.title')}</h1>
          <Link
            className={styles.primaryBtn}
            href={`/invoices/new${clientCompanyId ? `?client=${encodeURIComponent(clientCompanyId)}` : ''}`}
          >
            {t('einv.new')}
          </Link>
        </div>

        {error && <ErrorState message={error} onRetry={() => clientCompanyId && load(clientCompanyId)} />}
        {!error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}
        {!error && !loading && rows && rows.length === 0 && (
          <EmptyState message={t('einv.empty')} detail={t('einv.emptyDetail')} />
        )}
        {!error && !loading && rows && rows.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('einv.docType')}</th>
                  <th scope="col">{t('einv.number')}</th>
                  <th scope="col">{t('einv.issueDate')}</th>
                  <th scope="col" className={styles.colAmount}>{t('einv.total')}</th>
                  <th scope="col">{t('einv.peppol')}</th>
                  <th scope="col">{t('einv.vid')}</th>
                  <th scope="col">{t('einv.vidDue')}</th>
                  <th scope="col"><span className="sr-only">{t('einv.viewDoc')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{docTypeLabel(r)}</td>
                    <td className={styles.mono}>{r.invoiceNumber}</td>
                    <td>{fmtDate(r.issueDate)}</td>
                    <td className={styles.colAmount}>{formatCents(r.grandTotalCents, r.currency) ?? '—'}</td>
                    <td>{statusLabel(r.peppolStatus)}</td>
                    <td>{statusLabel(r.vidStatus)}</td>
                    <td>{r.vidDueDate ? fmtDate(r.vidDueDate) : '—'}</td>
                    <td>
                      {r.direction === 'outbound' && clientCompanyId ? (
                        <a
                          href={`/invoice-document/${r.id}?client=${encodeURIComponent(clientCompanyId)}&lang=${lang}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t('einv.viewDoc')}
                        </a>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

function InvoicesSkeleton() {
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
    <Suspense fallback={<InvoicesSkeleton />}>
      <InvoicesInner />
    </Suspense>
  );
}

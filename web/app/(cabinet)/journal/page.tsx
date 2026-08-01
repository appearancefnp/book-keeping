'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { LoadMoreButton } from '@/app/components/LoadMoreButton';
import styles from './page.module.css';

const PAGE_SIZE = 50;

interface JournalLine { accountCode: string; accountName: string; debit: string; credit: string; description: string | null; }
interface JournalEntry { id: string; entryDate: string; memo: string; currency: string; reversesEntryId: string | null; lines: JournalLine[]; }

function isZero(v: string): boolean { return !v || Number(v) === 0; }

function JournalInner() {
  const searchParams = useSearchParams();
  const { t, lang } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [entries, setEntries] = useState<JournalEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const load = useCallback(async (id: string, max: number, quiet: boolean) => {
    if (quiet) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/journal?clientCompanyId=${encodeURIComponent(id)}&limit=${max}`,
        { cache: 'no-store' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setEntries(((await res.json()) as { entries: JournalEntry[] }).entries);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [t]);

  useEffect(() => {
    setLimit(PAGE_SIZE);
    if (clientCompanyId) load(clientCompanyId, PAGE_SIZE, false);
  }, [clientCompanyId, load]);

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  const fmtAmount = (v: string) =>
    isZero(v) ? '—' : new Intl.NumberFormat('lv-LV', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v));

  const canLoadMore = !!entries && entries.length >= limit;

  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <h1 className={styles.pageHeading}>{t('journal.title')}</h1>

        {error && <ErrorState message={error} onRetry={() => clientCompanyId && load(clientCompanyId, limit, false)} />}
        {!error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}
        {!error && !loading && entries && entries.length === 0 && (
          <EmptyState message={t('journal.empty')} detail={t('journal.emptyDetail')} />
        )}
        {!error && !loading && entries && entries.length > 0 && (
          <div className={styles.entries}>
            {entries.map((e) => (
              <article key={e.id} className={styles.entry}>
                <header className={styles.entryHead}>
                  <span className={styles.entryDate}>{fmtDate(e.entryDate)}</span>
                  <span className={styles.entryMemo}>{e.memo}</span>
                  {e.reversesEntryId && <span className={styles.reversal}>{t('journal.reversal')}</span>}
                </header>
                <div className={styles.tableWrapper}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">{t('over.account')}</th>
                        <th scope="col" className={styles.colAmount}>{t('over.debit')}</th>
                        <th scope="col" className={styles.colAmount}>{t('over.credit')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {e.lines.map((l, i) => (
                        <tr key={i}>
                          <td>
                            <span className={styles.mono}>{l.accountCode}</span>
                            <span className={styles.accountName}> {l.accountName}</span>
                          </td>
                          <td className={styles.colAmount}>{fmtAmount(l.debit)}</td>
                          <td className={styles.colAmount}>{fmtAmount(l.credit)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            ))}
            {canLoadMore && (
              <LoadMoreButton
                busy={loadingMore}
                onClick={() => {
                  const next = limit + PAGE_SIZE;
                  setLimit(next);
                  if (clientCompanyId) load(clientCompanyId, next, true);
                }}
              />
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function JournalSkeleton() {
  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </section>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<JournalSkeleton />}>
      <JournalInner />
    </Suspense>
  );
}

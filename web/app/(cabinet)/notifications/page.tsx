'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { NotificationList, type NotificationRow } from '@/app/components/NotificationList';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { LoadMoreButton } from '@/app/components/LoadMoreButton';
import styles from './page.module.css';

// Growing-window pagination: "show more" refetches with a larger limit.
const PAGE_SIZE = 50;

function NotificationsInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (id: string, max: number, quiet = false) => {
    if (quiet) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/notifications?clientCompanyId=${encodeURIComponent(id)}&limit=${max}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { notifications: NotificationRow[] };
      setNotifications(data.notifications);
    } catch (err) {
      const e = err as Error;
      setError(e.message ?? t('state.error'));
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) {
      setLimit(PAGE_SIZE);
      load(clientCompanyId, PAGE_SIZE);
    }
  }, [clientCompanyId, load]);

  function handleLoadMore() {
    if (!clientCompanyId || loadingMore) return;
    const next = limit + PAGE_SIZE;
    setLimit(next);
    load(clientCompanyId, next, true);
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('notif.title')}</h1>

        {/* No client selected */}
        {!clientCompanyId && (
          <EmptyState message={t('notif.title')} detail={t('notif.selectClient')} />
        )}

        {/* Error */}
        {clientCompanyId && error && (
          <ErrorState
            message={error}
            onRetry={() => clientCompanyId && load(clientCompanyId, limit)}
          />
        )}

        {/* Loading */}
        {clientCompanyId && !error && loading && (
          <div className={styles.skeletons}>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {/* Notification list */}
        {!error && !loading && clientCompanyId && (
          <>
            <NotificationList
              notifications={notifications}
              clientCompanyId={clientCompanyId}
              onChanged={() => load(clientCompanyId, limit)}
            />
            {notifications.length >= limit && (
              <LoadMoreButton onClick={handleLoadMore} busy={loadingMore} />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function NotificationsSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.skeletons}>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<NotificationsSkeleton />}>
      <NotificationsInner />
    </Suspense>
  );
}

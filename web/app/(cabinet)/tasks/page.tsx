'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { TaskList, type TaskRow } from '@/app/components/TaskList';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { LoadMoreButton } from '@/app/components/LoadMoreButton';
import styles from './page.module.css';

// Growing-window pagination: "show more" refetches with a larger limit.
const PAGE_SIZE = 50;

// ── Inner component (reads useSearchParams) ───────────────────

function TasksInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(async (id: string, max: number, quiet = false) => {
    if (quiet) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks?clientCompanyId=${encodeURIComponent(id)}&limit=${max}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { tasks: TaskRow[] };
      setTasks(data.tasks);
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

  function handleTaskResolved(id: string) {
    setTasks((prev) =>
      prev.map((task) => (task.id === id ? { ...task, status: 'resolved' as const } : task))
    );
  }

  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <h1 className={styles.pageHeading}>{t('tasks.title')}</h1>

        {/* No client selected */}
        {!clientCompanyId && (
          <EmptyState message={t('tasks.title')} detail={t('tasks.selectClient')} />
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

        {/* Task list (includes empty state) */}
        {!error && !loading && clientCompanyId && (
          <>
            <TaskList
              tasks={tasks}
              clientCompanyId={clientCompanyId}
              onTaskResolved={handleTaskResolved}
            />
            {tasks.length >= limit && (
              <LoadMoreButton onClick={handleLoadMore} busy={loadingMore} />
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ── Skeleton fallback ─────────────────────────────────────────

function TasksSkeleton() {
  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <div className={styles.skeletons}>
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </section>
    </div>
  );
}

// ── Default export ────────────────────────────────────────────

export default function Page() {
  return (
    <Suspense fallback={<TasksSkeleton />}>
      <TasksInner />
    </Suspense>
  );
}

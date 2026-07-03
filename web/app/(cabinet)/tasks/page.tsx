'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { TaskList, type TaskRow } from '@/app/components/TaskList';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import styles from './page.module.css';

// ── Inner component (reads useSearchParams) ───────────────────

function TasksInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tasks?clientCompanyId=${encodeURIComponent(id)}`);
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
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  function handleTaskResolved(id: string) {
    setTasks((prev) =>
      prev.map((task) => (task.id === id ? { ...task, status: 'resolved' as const } : task))
    );
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('tasks.title')}</h1>

        {/* Error */}
        {error && (
          <ErrorState
            message={error}
            onRetry={() => clientCompanyId && load(clientCompanyId)}
          />
        )}

        {/* Loading */}
        {!error && loading && (
          <div className={styles.skeletons}>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {/* Task list (includes empty state) */}
        {!error && !loading && clientCompanyId && (
          <TaskList
            tasks={tasks}
            clientCompanyId={clientCompanyId}
            onTaskResolved={handleTaskResolved}
          />
        )}
      </main>
    </div>
  );
}

// ── Skeleton fallback ─────────────────────────────────────────

function TasksSkeleton() {
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

// ── Default export ────────────────────────────────────────────

export default function Page() {
  return (
    <Suspense fallback={<TasksSkeleton />}>
      <TasksInner />
    </Suspense>
  );
}

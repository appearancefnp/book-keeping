'use client';

import { useState } from 'react';
import { useMessages } from '@/app/lib/i18n-context';
import { EmptyState } from './EmptyState';
import { CommentThread } from './CommentThread';
import styles from './TaskList.module.css';

export interface TaskRow {
  id: string;
  title: string;
  detail?: string | null;
  status: 'open' | 'resolved';
}

export interface TaskListProps {
  tasks: TaskRow[];
  clientCompanyId: string;
  onTaskResolved: (id: string) => void;
}

export function TaskList({ tasks, clientCompanyId, onTaskResolved }: TaskListProps) {
  const { t } = useMessages();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resolvingIds, setResolvingIds] = useState<Set<string>>(new Set());
  const [resolveErrors, setResolveErrors] = useState<Record<string, string>>({});

  if (tasks.length === 0) {
    return <EmptyState message={t('tasks.empty')} />;
  }

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id));
  }

  async function handleMarkDone(id: string) {
    if (resolvingIds.has(id)) return;
    setResolvingIds((prev) => new Set(prev).add(id));
    setResolveErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
    try {
      const res = await fetch(`/api/tasks/${encodeURIComponent(id)}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId }),
      });
      if (res.ok) {
        onTaskResolved(id);
      } else {
        setResolveErrors((prev) => ({ ...prev, [id]: t('state.error') }));
      }
    } catch {
      setResolveErrors((prev) => ({ ...prev, [id]: t('state.error') }));
    } finally {
      setResolvingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <ul className={styles.list}>
      {tasks.map((task) => {
        const isResolved = task.status === 'resolved';
        const isExpanded = expandedId === task.id;
        const isBusy = resolvingIds.has(task.id);
        const resolveError = resolveErrors[task.id] ?? null;

        return (
          <li
            key={task.id}
            className={`${styles.item} ${isResolved ? styles.itemResolved : ''}`}
          >
            <div className={styles.card}>
              <div className={styles.cardHeader}>
                <div className={styles.cardMeta}>
                  {isResolved && (
                    <span className={styles.resolvedChip}>{t('tasks.resolved')}</span>
                  )}
                  <span className={styles.taskTitle}>{task.title}</span>
                </div>
                <div className={styles.cardActions}>
                  {!isResolved && (
                    <button
                      type="button"
                      className={styles.btnDone}
                      onClick={() => handleMarkDone(task.id)}
                      disabled={isBusy}
                      aria-label={`${t('tasks.complete')}: ${task.title}`}
                    >
                      {isBusy ? '…' : t('tasks.complete')}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${styles.btnExpand} ${isExpanded ? styles.btnExpandOpen : ''}`}
                    onClick={() => toggleExpand(task.id)}
                    aria-expanded={isExpanded}
                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} comments: ${task.title}`}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M4 6l4 4 4-4"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              {task.detail && (
                <p className={styles.taskDetail}>{task.detail}</p>
              )}
              {resolveError && (
                <p className={styles.resolveError} role="alert">{resolveError}</p>
              )}
            </div>

            {isExpanded && (
              <CommentThread taskId={task.id} clientCompanyId={clientCompanyId} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

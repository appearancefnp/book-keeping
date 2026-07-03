'use client';

import { useState } from 'react';
import { useMessages } from '@/app/lib/i18n-context';
import { EmptyState } from './EmptyState';
import styles from './NotificationList.module.css';

export interface NotificationRow {
  id: string;
  kind: string;
  message: string;
  read: boolean;
  createdAt: string;
}

export interface NotificationListProps {
  notifications: NotificationRow[];
  clientCompanyId: string;
  onChanged: () => void;
}

function formatDate(iso: string, t: (k: import('@/app/lib/i18n').MsgKey) => string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return t('time.justNow');
  if (diffMins < 60) return `${diffMins}${t('time.minutesAgo')}`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}${t('time.hoursAgo')}`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}${t('time.daysAgo')}`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function prettyKind(k: string): string {
  const s = k.replace(/_/g, ' ').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function NotificationList({ notifications, clientCompanyId, onChanged }: NotificationListProps) {
  const { t } = useMessages();
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [busyAll, setBusyAll] = useState(false);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [globalError, setGlobalError] = useState<string | null>(null);

  if (notifications.length === 0) {
    return <EmptyState message={t('notif.empty')} />;
  }

  const hasUnread = notifications.some((n) => !n.read);

  async function handleMarkRead(id: string) {
    if (busyIds.has(id)) return;
    setBusyIds((prev) => new Set(prev).add(id));
    setRowErrors((prev) => { const next = { ...prev }; delete next[id]; return next; });
    try {
      const res = await fetch(`/api/notifications/${encodeURIComponent(id)}/read`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('state.error');
      setRowErrors((prev) => ({ ...prev, [id]: msg }));
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
    }
  }

  async function handleMarkAll() {
    if (busyAll) return;
    setBusyAll(true);
    setGlobalError(null);
    try {
      const res = await fetch('/api/notifications/read-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      onChanged();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('state.error');
      setGlobalError(msg);
    } finally {
      setBusyAll(false);
    }
  }

  return (
    <div className={styles.root}>
      {hasUnread && (
        <div className={styles.toolbar}>
          <button
            type="button"
            className={styles.btnMarkAll}
            onClick={handleMarkAll}
            disabled={busyAll}
          >
            {busyAll ? '…' : t('notif.markAll')}
          </button>
        </div>
      )}

      {globalError && (
        <p className={styles.globalError} role="alert">{globalError}</p>
      )}

      <ul className={styles.list}>
        {notifications.map((notif) => {
          const isBusy = busyIds.has(notif.id);
          const rowError = rowErrors[notif.id] ?? null;

          return (
            <li
              key={notif.id}
              className={`${styles.item} ${!notif.read ? styles.itemUnread : ''}`}
            >
              <div className={styles.itemContent}>
                <div className={styles.itemHeader}>
                  <div className={styles.itemMeta}>
                    {!notif.read && (
                      <span className={styles.unreadDot} aria-hidden="true" />
                    )}
                    <span className={styles.kind}>{prettyKind(notif.kind)}</span>
                    <span className={styles.time}>{formatDate(notif.createdAt, t)}</span>
                  </div>
                  {!notif.read && (
                    <button
                      type="button"
                      className={styles.btnRead}
                      onClick={() => handleMarkRead(notif.id)}
                      disabled={isBusy}
                      aria-label={`${t('notif.markRead')}: ${notif.message}`}
                    >
                      {isBusy ? '…' : t('notif.markRead')}
                    </button>
                  )}
                </div>
                <p className={`${styles.message} ${!notif.read ? styles.messageUnread : ''}`}>
                  {notif.message}
                </p>
                {rowError && (
                  <p className={styles.rowError} role="alert">{rowError}</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

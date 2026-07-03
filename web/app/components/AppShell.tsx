'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { LanguageProvider, useMessages } from '@/app/lib/i18n-context';
import { fetchClients } from '@/app/lib/api-client';
import type { ClientCompany } from '@/app/lib/api-client';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { ChatPanel } from './ChatPanel';
import styles from './AppShell.module.css';

interface AppShellProps {
  role: string;
  children: React.ReactNode;
}

function AppShellInner({ role, children }: AppShellProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useMessages();

  const [clients, setClients] = useState<ClientCompany[]>([]);
  const [activeClientId, setActiveClientId] = useState<string | null>(
    searchParams.get('client'),
  );
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const assistantRef = useRef<HTMLElement>(null);
  const assistantCloseRef = useRef<HTMLButtonElement>(null);
  // Element that had focus before the panel opened, so we can restore it on close.
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const loadClients = useCallback(async () => {
    try {
      const { clients: loaded } = await fetchClients();
      setClients(loaded);
      // If no active client yet, default to first
      if (!searchParams.get('client') && loaded.length > 0) {
        const first = loaded[0];
        if (first) {
          setActiveClientId(first.id);
          const params = new URLSearchParams(searchParams.toString());
          params.set('client', first.id);
          router.replace(`?${params.toString()}`);
        }
      }
    } catch {
      // Silently ignore — the queue page shows its own error state
    }
  }, [router, searchParams]);

  const loadUnreadCount = useCallback(async (clientId: string) => {
    try {
      const res = await fetch(
        `/api/notifications?clientCompanyId=${encodeURIComponent(clientId)}&unreadOnly=true`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { notifications: unknown[] };
      setUnreadCount(data.notifications.length);
    } catch {
      // Badge staleness is acceptable; silently ignore
    }
  }, []);

  useEffect(() => {
    loadClients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeClientId) loadUnreadCount(activeClientId);
    else setUnreadCount(0);
  }, [activeClientId, loadUnreadCount]);

  function handleClientChange(id: string) {
    setActiveClientId(id);
    const params = new URLSearchParams(searchParams.toString());
    params.set('client', id);
    router.push(`?${params.toString()}`);
  }

  function handleAsk() {
    setAssistantOpen((prev) => !prev);
  }

  // Escape closes the panel from anywhere while it's open.
  useEffect(() => {
    if (!assistantOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setAssistantOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [assistantOpen]);

  // Move focus into the panel on open; restore it to the trigger on close.
  useEffect(() => {
    if (assistantOpen) {
      returnFocusRef.current = document.activeElement as HTMLElement | null;
      assistantCloseRef.current?.focus();
    } else {
      returnFocusRef.current?.focus();
      returnFocusRef.current = null;
    }
  }, [assistantOpen]);

  return (
    <div className={styles.shell}>
      <Sidebar role={role} unreadCount={unreadCount} />
      <div className={styles.body}>
        <TopBar
          clients={clients}
          activeClientId={activeClientId}
          onClientChange={handleClientChange}
          role={role}
          onAsk={handleAsk}
        />
        <main className={styles.main}>
          {children}
        </main>
      </div>

      {/* Assistant slide-over host. `inert` when closed removes it from tab order
          and hit-testing — aria-hidden alone leaves it keyboard-reachable. */}
      <aside
        ref={assistantRef}
        className={`${styles.assistant}${assistantOpen ? ` ${styles.assistantOpen}` : ''}`}
        aria-label={t('asst.title')}
        role="dialog"
        inert={!assistantOpen}
      >
        <div className={styles.assistantHeader}>
          <span className={styles.assistantTitle}>{t('asst.title')}</span>
          <button
            ref={assistantCloseRef}
            className={styles.assistantClose}
            onClick={() => setAssistantOpen(false)}
            aria-label={t('asst.close')}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className={styles.assistantInner}>
          <ChatPanel clientCompanyId={activeClientId} />
        </div>
      </aside>
    </div>
  );
}

export function AppShell({ role, children }: AppShellProps) {
  return (
    <Suspense>
      <LanguageProvider>
        <AppShellInner role={role}>{children}</AppShellInner>
      </LanguageProvider>
    </Suspense>
  );
}

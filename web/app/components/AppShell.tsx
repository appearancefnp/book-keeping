'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { LanguageProvider } from '@/app/lib/i18n-context';
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

  const [clients, setClients] = useState<ClientCompany[]>([]);
  const [activeClientId, setActiveClientId] = useState<string | null>(
    searchParams.get('client'),
  );
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

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

      {/* Assistant slide-over host */}
      <aside
        className={`${styles.assistant}${assistantOpen ? ` ${styles.assistantOpen}` : ''}`}
        aria-label="Assistant"
        aria-hidden={!assistantOpen}
      >
        <div className={styles.assistantHeader}>
          <span className={styles.assistantTitle}>Assistant</span>
          <button
            className={styles.assistantClose}
            onClick={() => setAssistantOpen(false)}
            aria-label="Close assistant"
          >
            ✕
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

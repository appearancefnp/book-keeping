'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { LanguageProvider } from '@/app/lib/i18n-context';
import { fetchClients } from '@/app/lib/api-client';
import type { ClientCompany } from '@/app/lib/api-client';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
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

  useEffect(() => {
    loadClients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      <Sidebar role={role} />
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

      {/* Assistant slide-over host — Task 5 fills this panel */}
      <aside
        className={`${styles.assistant}${assistantOpen ? ` ${styles.assistantOpen}` : ''}`}
        aria-label="Assistant"
        aria-hidden={!assistantOpen}
      >
        <div className={styles.assistantInner}>
          {/* Task 5 mounts the panel here */}
        </div>
      </aside>
    </div>
  );
}

export function AppShell({ role, children }: AppShellProps) {
  return (
    <LanguageProvider>
      <Suspense>
        <AppShellInner role={role}>{children}</AppShellInner>
      </Suspense>
    </LanguageProvider>
  );
}

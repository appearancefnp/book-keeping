'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { Proposal } from './lib/proposal-types';
import type { ClientCompany } from './lib/api-client';
import {
  fetchClients,
  fetchProposals,
  approveProposal,
  rejectProposal,
} from './lib/api-client';
import { AppHeader } from './components/AppHeader';
import { ProposalCard } from './components/ProposalCard';
import { SkeletonCard } from './components/SkeletonCard';
import { EmptyState } from './components/EmptyState';
import { ErrorState } from './components/ErrorState';
import { Toast } from './components/Toast';
import type { ToastKind } from './components/Toast';
import styles from './page.module.css';

// ── Toast state ──────────────────────────────────────────────────────────────

interface ToastEntry {
  id: number;
  message: string;
  kind: ToastKind;
}

let toastCounter = 0;

// ── Per-card action state ────────────────────────────────────────────────────

interface CardState {
  busy: boolean;
  leaving: boolean;
}

// ── ApprovalQueue (inner) ────────────────────────────────────────────────────
// Reads useSearchParams — must be inside the Suspense boundary.

function ApprovalQueue() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Clients
  const [clients, setClients] = useState<ClientCompany[]>([]);
  const [role, setRole] = useState<string | null>(null);
  const [clientsLoading, setClientsLoading] = useState(true);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [is401, setIs401] = useState(false);

  // Selected client
  const [selectedClientId, setSelectedClientId] = useState<string | null>(
    searchParams.get('client'),
  );

  // Proposals
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [proposalsError, setProposalsError] = useState<string | null>(null);

  // Per-card state (keyed by proposal id)
  const [cardStates, setCardStates] = useState<Record<string, CardState>>({});

  // Toast queue
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  // Inline error per card (action failures)
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});

  // Track whether proposals have loaded at least once for this client
  // (to distinguish "initial loading" from "re-fetching")
  const loadedClientRef = useRef<string | null>(null);

  // ── Helpers ────────────────────────────────────────────────────────────────

  function pushToast(message: string, kind: ToastKind) {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, message, kind }]);
  }

  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  function setCardBusy(id: string, busy: boolean) {
    setCardStates((prev) => ({ ...prev, [id]: { ...prev[id], busy, leaving: prev[id]?.leaving ?? false } }));
  }

  function setCardLeaving(id: string, leaving: boolean) {
    setCardStates((prev) => ({ ...prev, [id]: { ...prev[id], leaving, busy: prev[id]?.busy ?? false } }));
  }

  function clearCardState(id: string) {
    setCardStates((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function setCardError(id: string, msg: string) {
    setCardErrors((prev) => ({ ...prev, [id]: msg }));
  }

  function clearCardError(id: string) {
    setCardErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  // ── Load clients on mount ──────────────────────────────────────────────────

  const loadClients = useCallback(async () => {
    setClientsLoading(true);
    setClientsError(null);
    setIs401(false);
    try {
      const { clients: loaded, role: loadedRole } = await fetchClients();
      setClients(loaded);
      setRole(loadedRole);
      // If no client in URL, default to first
      const urlClient = searchParams.get('client');
      if (!urlClient && loaded.length > 0) {
        const first = loaded[0];
        if (first) {
          setSelectedClientId(first.id);
          router.replace(`/?client=${encodeURIComponent(first.id)}`);
        }
      }
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 401) {
        setIs401(true);
      }
      setClientsError(e.message ?? 'Failed to load clients');
    } finally {
      setClientsLoading(false);
    }
  }, [router, searchParams]);

  useEffect(() => {
    loadClients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Load proposals when client changes ────────────────────────────────────

  const loadProposals = useCallback(async (clientId: string) => {
    setProposalsLoading(true);
    setProposalsError(null);
    loadedClientRef.current = clientId;
    try {
      const loaded = await fetchProposals(clientId);
      // Only update if the client hasn't changed mid-flight
      if (loadedClientRef.current === clientId) {
        setProposals(loaded);
        setCardStates({});
        setCardErrors({});
      }
    } catch (err) {
      if (loadedClientRef.current === clientId) {
        const e = err as Error & { status?: number };
        setProposalsError(e.message ?? 'Failed to load proposals');
      }
    } finally {
      if (loadedClientRef.current === clientId) {
        setProposalsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    if (selectedClientId) {
      loadProposals(selectedClientId);
    }
  }, [selectedClientId, loadProposals]);

  // ── Client selection ───────────────────────────────────────────────────────

  function handleSelectClient(id: string) {
    setSelectedClientId(id);
    router.push(`/?client=${encodeURIComponent(id)}`);
  }

  // ── Approve flow ───────────────────────────────────────────────────────────

  async function handleApprove(id: string) {
    if (!selectedClientId) return;
    clearCardError(id);
    setCardBusy(id, true);
    try {
      await approveProposal(id, selectedClientId);
      setCardBusy(id, false);
      setCardLeaving(id, true);
      setTimeout(() => {
        setProposals((prev) => prev.filter((p) => p.id !== id));
        clearCardState(id);
        pushToast('Approved — posted to the ledger.', 'ok');
      }, 250);
    } catch (err) {
      setCardBusy(id, false);
      const e = err as Error;
      setCardError(id, e.message ?? 'Failed to approve');
    }
  }

  // ── Reject flow ────────────────────────────────────────────────────────────

  async function handleReject(id: string, reason: string) {
    if (!selectedClientId) return;
    clearCardError(id);
    setCardBusy(id, true);
    try {
      await rejectProposal(id, selectedClientId, reason);
      setCardBusy(id, false);
      setCardLeaving(id, true);
      setTimeout(() => {
        setProposals((prev) => prev.filter((p) => p.id !== id));
        clearCardState(id);
        pushToast('Rejected.', 'ok');
      }, 250);
    } catch (err) {
      setCardBusy(id, false);
      const e = err as Error;
      setCardError(id, e.message ?? 'Failed to reject');
    }
  }

  // ── Retry ──────────────────────────────────────────────────────────────────

  function handleRetry() {
    if (clientsError) {
      loadClients();
    } else if (proposalsError && selectedClientId) {
      loadProposals(selectedClientId);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const isLoading = clientsLoading || proposalsLoading;
  const error = clientsError ?? proposalsError;

  return (
    <div className={styles.page}>
      <AppHeader
        clients={clients}
        selectedClientId={selectedClientId}
        onSelectClient={handleSelectClient}
        role={role}
        language="LV"
      />

      <main className={styles.main}>
        <h1 className={styles.queueHeading}>Approval queue</h1>

        {/* 401 / not signed in */}
        {is401 && (
          <div className={styles.authNotice} role="alert">
            <h2>Not signed in</h2>
            <p>
              No active session found. To sign in for local development, visit{' '}
              <code>/api/dev/bootstrap</code> — it seeds the database, creates a session, and
              redirects back here.
            </p>
          </div>
        )}

        {/* General error (non-401) */}
        {!is401 && error && (
          <ErrorState message={error} onRetry={handleRetry} />
        )}

        {/* Loading skeletons */}
        {!error && isLoading && (
          <ul className={styles.list} aria-label="Loading proposals">
            <li><SkeletonCard /></li>
            <li><SkeletonCard /></li>
            <li><SkeletonCard /></li>
          </ul>
        )}

        {/* Empty state */}
        {!error && !isLoading && selectedClientId && proposals.length === 0 && (
          <EmptyState />
        )}

        {/* Proposal list */}
        {!error && !isLoading && proposals.length > 0 && (
          <section aria-labelledby="queue-heading">
            <h2 id="queue-heading" className="sr-only">Proposals awaiting approval</h2>
            <ul className={styles.list}>
              {proposals.map((proposal, i) => {
                const cs = cardStates[proposal.id];
                const cardErr = cardErrors[proposal.id];
                return (
                  <li
                    key={proposal.id}
                    className={styles.listItem}
                    style={{ animationDelay: `${i * 60}ms` }}
                  >
                    {cardErr && (
                      <p role="alert" style={{
                        color: 'var(--danger)',
                        fontSize: '0.875rem',
                        marginBottom: 'var(--space-2)',
                        padding: '0 var(--space-1)',
                      }}>
                        {cardErr}
                      </p>
                    )}
                    <ProposalCard
                      proposal={proposal}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      busy={cs?.busy ?? false}
                      leaving={cs?.leaving ?? false}
                    />
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </main>

      {/* Toast region — screen-reader live region */}
      <div className={styles.toastRegion} aria-label="Notifications">
        {toasts.map((t) => (
          <Toast
            key={t.id}
            message={t.message}
            kind={t.kind}
            onDismiss={() => dismissToast(t.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Skeleton fallback for Suspense ────────────────────────────────────────────

function QueueSkeleton() {
  return (
    <div className={styles.page}>
      <div style={{
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        height: 56,
      }} />
      <main className={styles.main}>
        <ul className={styles.list}>
          <li><SkeletonCard /></li>
          <li><SkeletonCard /></li>
          <li><SkeletonCard /></li>
        </ul>
      </main>
    </div>
  );
}

// ── Default export: thin Suspense wrapper ─────────────────────────────────────
// Required because ApprovalQueue uses useSearchParams(), which must be inside
// a Suspense boundary in Next.js 16 / React 19 or the build will fail.

export default function Page() {
  return (
    <Suspense fallback={<QueueSkeleton />}>
      <ApprovalQueue />
    </Suspense>
  );
}

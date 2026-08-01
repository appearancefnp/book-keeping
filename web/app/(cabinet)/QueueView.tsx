'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Proposal } from '@/app/lib/proposal-types';
import {
  fetchProposals,
  approveProposal,
  rejectProposal,
} from '@/app/lib/api-client';
import { useMessages } from '@/app/lib/i18n-context';
import { ProposalCard } from '@/app/components/ProposalCard';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { EmptyState } from '@/app/components/EmptyState';
import { ErrorState } from '@/app/components/ErrorState';
import { LoadMoreButton } from '@/app/components/LoadMoreButton';
import { Toast } from '@/app/components/Toast';
import type { ToastKind } from '@/app/components/Toast';
import styles from './page.module.css';

// Page size for the growing-window pagination: "show more" refetches with a
// larger limit rather than offsetting, so approvals shrinking the queue can't
// skip items.
const PAGE_SIZE = 50;

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
  const searchParams = useSearchParams();
  const { t } = useMessages();

  // Active client comes from the shell via ?client= URL param
  const selectedClientId = searchParams.get('client');

  // Proposals
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [proposalsError, setProposalsError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);

  // Per-card state (keyed by proposal id)
  const [cardStates, setCardStates] = useState<Record<string, CardState>>({});

  // Toast queue
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  // Inline error per card (action failures)
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});

  // Track whether proposals have loaded at least once for this client
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

  // ── Load proposals when client changes ────────────────────────────────────

  const loadProposals = useCallback(async (clientId: string, max: number, quiet = false) => {
    if (quiet) setLoadingMore(true);
    else setProposalsLoading(true);
    setProposalsError(null);
    loadedClientRef.current = clientId;
    try {
      const loaded = await fetchProposals(clientId, max);
      if (loadedClientRef.current === clientId) {
        setProposals(loaded);
        if (!quiet) {
          setCardStates({});
          setCardErrors({});
        }
      }
    } catch (err) {
      if (loadedClientRef.current === clientId) {
        const e = err as Error & { status?: number };
        setProposalsError(e.message ?? t('state.error'));
      }
    } finally {
      if (loadedClientRef.current === clientId) {
        setProposalsLoading(false);
        setLoadingMore(false);
      }
    }
  }, [t]);

  useEffect(() => {
    if (selectedClientId) {
      setLimit(PAGE_SIZE);
      loadProposals(selectedClientId, PAGE_SIZE);
    }
  }, [selectedClientId, loadProposals]);

  function handleLoadMore() {
    if (!selectedClientId || loadingMore) return;
    const next = limit + PAGE_SIZE;
    setLimit(next);
    loadProposals(selectedClientId, next, true);
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
        pushToast(t('queue.approved'), 'ok');
      }, 250);
    } catch (err) {
      setCardBusy(id, false);
      const e = err as Error;
      setCardError(id, e.message ?? t('queue.approveFailed'));
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
        pushToast(t('queue.rejected'), 'ok');
      }, 250);
    } catch (err) {
      setCardBusy(id, false);
      const e = err as Error;
      setCardError(id, e.message ?? t('queue.rejectFailed'));
    }
  }

  // ── Retry ──────────────────────────────────────────────────────────────────

  function handleRetry() {
    if (proposalsError && selectedClientId) {
      loadProposals(selectedClientId, limit);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <h1 className={styles.queueHeading}>{t('nav.queue')}</h1>

        {/* General error */}
        {proposalsError && (
          <ErrorState message={proposalsError} onRetry={handleRetry} />
        )}

        {/* Loading skeletons */}
        {!proposalsError && proposalsLoading && (
          <ul className={styles.list} aria-label={t('state.loading')}>
            <li><SkeletonCard /></li>
            <li><SkeletonCard /></li>
            <li><SkeletonCard /></li>
          </ul>
        )}

        {/* Empty state */}
        {!proposalsError && !proposalsLoading && selectedClientId && proposals.length === 0 && (
          <EmptyState />
        )}

        {/* Proposal list */}
        {!proposalsError && !proposalsLoading && proposals.length > 0 && (
          <section aria-labelledby="queue-heading">
            <h2 id="queue-heading" className="sr-only">{t('queue.awaiting')}</h2>
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
            {proposals.length >= limit && (
              <LoadMoreButton onClick={handleLoadMore} busy={loadingMore} />
            )}
          </section>
        )}
      </section>

      {/* Toast region — screen-reader live region */}
      <div className={styles.toastRegion} aria-label={t('nav.notifications')}>
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
      <section className={styles.main}>
        <ul className={styles.list}>
          <li><SkeletonCard /></li>
          <li><SkeletonCard /></li>
          <li><SkeletonCard /></li>
        </ul>
      </section>
    </div>
  );
}

// ── Named export ────────────────────────────────────────────────────────────

export function QueueView() {
  return (
    <Suspense fallback={<QueueSkeleton />}>
      <ApprovalQueue />
    </Suspense>
  );
}

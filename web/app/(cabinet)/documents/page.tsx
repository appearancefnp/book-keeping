'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import type { DocumentRow } from '@/app/components/DocumentList';
import { DocumentList } from '@/app/components/DocumentList';
import { FileDropzone } from '@/app/components/FileDropzone';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { LoadMoreButton } from '@/app/components/LoadMoreButton';
import { Toast } from '@/app/components/Toast';
import type { ToastKind } from '@/app/components/Toast';
import styles from './page.module.css';

// Growing-window pagination: "show more" refetches with a larger limit.
const PAGE_SIZE = 50;

interface ToastEntry {
  id: number;
  message: string;
  kind: ToastKind;
}

let toastCounter = 0;

// ── Documents inner (reads useSearchParams) ───────────────────────────────────

function DocumentsInner() {
  const { t } = useMessages();
  const searchParams = useSearchParams();
  const clientCompanyId = searchParams.get('client');

  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loadingMore, setLoadingMore] = useState(false);

  function pushToast(message: string, kind: ToastKind) {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, message, kind }]);
  }

  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  const loadDocuments = useCallback(async (cid: string, max: number, quiet = false) => {
    if (quiet) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/documents?clientCompanyId=${encodeURIComponent(cid)}&limit=${max}`,
        { cache: 'no-store' },
      );
      const data = (await res.json()) as { documents?: DocumentRow[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setDocuments(data.documents ?? []);
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
      loadDocuments(clientCompanyId, PAGE_SIZE);
    }
  }, [clientCompanyId, loadDocuments]);

  function handleRetry() {
    if (clientCompanyId) loadDocuments(clientCompanyId, limit);
  }

  function handleUploaded() {
    if (clientCompanyId) loadDocuments(clientCompanyId, limit);
  }

  function handleLoadMore() {
    if (!clientCompanyId || loadingMore) return;
    const next = limit + PAGE_SIZE;
    setLimit(next);
    loadDocuments(clientCompanyId, next, true);
  }

  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <h1 className={styles.heading}>{t('docs.title')}</h1>

        {/* Upload zone */}
        {clientCompanyId && (
          <div className={styles.dropzoneWrap}>
            <FileDropzone
              clientCompanyId={clientCompanyId}
              uploadLabel={t('docs.upload')}
              onUploaded={handleUploaded}
              onToast={pushToast}
            />
          </div>
        )}

        {/* Loading */}
        {loading && (
          <ul className={styles.skeletonList} aria-label={t('state.loading')}>
            <li><SkeletonCard /></li>
            <li><SkeletonCard /></li>
          </ul>
        )}

        {/* Error */}
        {!loading && error && (
          <ErrorState message={error} onRetry={handleRetry} />
        )}

        {/* Document list */}
        {!loading && !error && clientCompanyId && (
          <>
            <DocumentList documents={documents} />
            {documents.length >= limit && (
              <LoadMoreButton onClick={handleLoadMore} busy={loadingMore} />
            )}
          </>
        )}
      </section>

      {/* Toast region */}
      <div className={styles.toastRegion} aria-label={t('nav.notifications')}>
        {toasts.map((entry) => (
          <Toast
            key={entry.id}
            message={entry.message}
            kind={entry.kind}
            onDismiss={() => dismissToast(entry.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Skeleton fallback ─────────────────────────────────────────────────────────

function DocumentsSkeleton() {
  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <ul className={styles.skeletonList}>
          <li><SkeletonCard /></li>
          <li><SkeletonCard /></li>
        </ul>
      </section>
    </div>
  );
}

// ── Default export ────────────────────────────────────────────────────────────

export default function Page() {
  return (
    <Suspense fallback={<DocumentsSkeleton />}>
      <DocumentsInner />
    </Suspense>
  );
}

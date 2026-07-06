'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Proposal } from '@/app/lib/proposal-types';
import { fetchMaterialApprovals, approveProposal, rejectProposal } from '@/app/lib/api-client';
import { useMessages } from '@/app/lib/i18n-context';
import { formatDecimal, formatCents } from '@/app/lib/format';
import { ProposalCard } from '@/app/components/ProposalCard';
import { FileDropzone } from '@/app/components/FileDropzone';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { EmptyState } from '@/app/components/EmptyState';
import { ErrorState } from '@/app/components/ErrorState';
import { Toast, type ToastKind } from '@/app/components/Toast';
import styles from './OwnerHome.module.css';

interface Overview {
  vat: { netPayable: string };
  receivables: { balanceCents: string };
}

function OwnerHomeInner() {
  const { t } = useMessages();
  const searchParams = useSearchParams();
  const clientId = searchParams.get('client');

  const [overview, setOverview] = useState<Overview | null>(null);
  const [approvals, setApprovals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; kind: ToastKind } | null>(null);

  const load = useCallback(async (cid: string, quiet = false) => {
    if (!quiet) setLoading(true);
    setError(false);
    try {
      const [ovRes, appr] = await Promise.all([
        fetch(`/api/overview?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' }),
        fetchMaterialApprovals(cid),
      ]);
      if (!ovRes.ok) throw new Error('overview');
      setOverview(await ovRes.json());
      setApprovals(appr);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (clientId) load(clientId); }, [clientId, load]);

  const onApprove = useCallback(async (id: string) => {
    if (!clientId) return;
    setBusyId(id);
    try {
      await approveProposal(id, clientId);
      setApprovals((prev) => prev.filter((p) => p.id !== id));
      await load(clientId, true);
    } catch {
      setToast({ message: t('owner.actionFailed'), kind: 'error' });
    } finally {
      setBusyId(null);
    }
  }, [clientId, t, load]);

  const onReject = useCallback(async (id: string, reason: string) => {
    if (!clientId) return;
    setBusyId(id);
    try {
      await rejectProposal(id, clientId, reason);
      setApprovals((prev) => prev.filter((p) => p.id !== id));
      await load(clientId, true);
    } catch {
      setToast({ message: t('owner.actionFailed'), kind: 'error' });
    } finally {
      setBusyId(null);
    }
  }, [clientId, t, load]);

  return (
    <div className={styles.page}>
      <h1 className={styles.pageHeading}>{t('owner.title')}</h1>

      <section aria-labelledby="pos-heading">
        <h2 id="pos-heading" className={styles.sectionHeading}>{t('owner.position')}</h2>
        {loading ? (
          <div className={styles.cards}><SkeletonCard /><SkeletonCard /></div>
        ) : error ? (
          <ErrorState message={t('owner.loadError')} onRetry={() => clientId && load(clientId)} />
        ) : (
          <div className={styles.cards}>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>{t('owner.vat')}</p>
              <p className={styles.statValue}>{overview ? (formatDecimal(overview.vat.netPayable) ?? '—') : '—'}</p>
            </div>
            <div className={styles.statCard}>
              <p className={styles.statLabel}>{t('owner.receivables')}</p>
              <p className={styles.statValue}>{overview ? (formatCents(overview.receivables.balanceCents) ?? '—') : '—'}</p>
            </div>
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="appr-heading">
        <h2 id="appr-heading" className={styles.sectionHeading}>{t('owner.approvals')}</h2>
        {loading ? (
          <SkeletonCard />
        ) : approvals.length === 0 ? (
          <EmptyState message={t('owner.approvals.empty')} />
        ) : (
          <div className={styles.list}>
            {approvals.map((p) => (
              <ProposalCard key={p.id} proposal={p} onApprove={onApprove} onReject={onReject} busy={busyId === p.id} />
            ))}
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="upload-heading">
        <h2 id="upload-heading" className={styles.sectionHeading}>{t('owner.upload')}</h2>
        {clientId && (
          <FileDropzone
            clientCompanyId={clientId}
            uploadLabel={t('owner.upload')}
            onUploaded={() => load(clientId)}
            onToast={(message, kind) => setToast({ message, kind })}
          />
        )}
      </section>

      {toast && <Toast message={toast.message} kind={toast.kind} onDismiss={() => setToast(null)} />}
    </div>
  );
}

export function OwnerHome() {
  return (
    <Suspense fallback={<SkeletonCard />}>
      <OwnerHomeInner />
    </Suspense>
  );
}

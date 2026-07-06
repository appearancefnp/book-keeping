'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { AdminTables, type ClientCompany, type UserRow, type AuditRow } from '@/app/components/AdminTables';
import { TariffTable, type FirmTariffRow } from '@/app/components/TariffTable';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import styles from './page.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdminData {
  clients: ClientCompany[];
  users: UserRow[];
  audit: AuditRow[];
  tariffs: FirmTariffRow[];
  role: string;
}

// ── Inner (reads useSearchParams) ─────────────────────────────────────────────

function AdminInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [data, setData] = useState<AdminData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setForbidden(false);

    try {
      const auditFetch: Promise<Response> = clientCompanyId
        ? fetch(`/api/audit?clientCompanyId=${encodeURIComponent(clientCompanyId)}`)
        : Promise.resolve(new Response('{"audit":[]}', { status: 200 }));

      const [clientsRes, usersRes, auditRes, tariffsRes] = await Promise.all([
        fetch('/api/admin/clients'),
        fetch('/api/admin/users'),
        auditFetch,
        fetch('/api/admin/tariffs'),
      ]);

      // Role gate: if either firm-level endpoint returns 403, show restricted notice
      if (clientsRes.status === 403 || usersRes.status === 403 || tariffsRes.status === 403) {
        setForbidden(true);
        return;
      }

      if (!clientsRes.ok) {
        const b = await clientsRes.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${clientsRes.status}`);
      }
      if (!usersRes.ok) {
        const b = await usersRes.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${usersRes.status}`);
      }
      if (!tariffsRes.ok) {
        const b = await tariffsRes.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${tariffsRes.status}`);
      }

      const [clientsJson, usersJson, auditJson] = await Promise.all([
        clientsRes.json(),
        usersRes.json(),
        auditRes.json(),
      ]);
      const tariffsBody = tariffsRes.ok ? await tariffsRes.json() : { tariffs: [], role: '' };

      setData({
        clients: (clientsJson as { clients: ClientCompany[] }).clients,
        users: (usersJson as { users: UserRow[] }).users,
        audit: (auditJson as { audit: AuditRow[] }).audit ?? [],
        tariffs: (tariffsBody as { tariffs: FirmTariffRow[] }).tariffs,
        role: (tariffsBody as { role: string }).role,
      });
    } catch (err) {
      const e = err as Error;
      setError(e.message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [clientCompanyId, t]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('admin.title')}</h1>

        {/* Forbidden */}
        {forbidden && (
          <EmptyState
            message={t('admin.restricted')}
            detail={t('admin.restrictedDetail')}
          />
        )}

        {/* Error */}
        {!forbidden && error && (
          <ErrorState message={error} onRetry={load} />
        )}

        {/* Loading */}
        {!forbidden && !error && loading && (
          <div className={styles.skeletons}>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {/* Data */}
        {!forbidden && !error && !loading && data && (
          <>
            <AdminTables
              clients={data.clients}
              users={data.users}
              audit={data.audit}
            />
            <TariffTable tariffs={data.tariffs} role={data.role} onSaved={load} />
          </>
        )}
      </main>
    </div>
  );
}

// ── Skeleton fallback ─────────────────────────────────────────────────────────

function AdminSkeleton() {
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

// ── Default export ────────────────────────────────────────────────────────────

export default function Page() {
  return (
    <Suspense fallback={<AdminSkeleton />}>
      <AdminInner />
    </Suspense>
  );
}

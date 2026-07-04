'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { LOCALE_FOR, type MsgKey } from '@/app/lib/i18n';
import { FigureRows } from '@/app/components/FigureRows';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { formatDecimal, formatCents, formatDateRange } from '@/app/lib/format';
import styles from './page.module.css';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TrialBalanceRow {
  code: string;
  name: string;
  debit: string;
  credit: string;
  balance: string;
}

interface VatRule {
  ruleType: string;
  value: string;
  effectiveFrom: string;
}

interface VidDeadline {
  einvoiceId: string;
  invoiceNumber: string;
  dueDate: string;
  overdue: boolean;
}

interface OverviewData {
  trialBalance: TrialBalanceRow[];
  vat: { netPayable: string; rule: VatRule };
  receivables: { balanceCents: string };
  period: { fromDate: string; toDate: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isZero(val: string): boolean {
  return !val || Number(val) === 0;
}

function fmtAmount(val: string): React.ReactNode {
  if (isZero(val)) return <span style={{ color: 'var(--ink-soft)' }}>—</span>;
  // Decimal string like "1234.56" — format with lv-LV grouping + EUR suffix
  return formatDecimal(val) ?? val;
}

// ── Trial balance table ───────────────────────────────────────────────────────

function TrialBalanceTable({ rows, t }: { rows: TrialBalanceRow[]; t: (k: MsgKey) => string }) {
  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col" className={styles.colAccount}>{t('over.account')}</th>
            <th scope="col" className={styles.colAmount}>{t('over.debit')}</th>
            <th scope="col" className={styles.colAmount}>{t('over.credit')}</th>
            <th scope="col" className={styles.colAmount}>{t('over.balance')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              <td className={styles.cellAccount}>
                <span className={styles.accountCode}>{row.code}</span>
                <span className={styles.accountName}>{row.name}</span>
              </td>
              <td className={styles.cellAmount}>{fmtAmount(row.debit)}</td>
              <td className={styles.cellAmount}>{fmtAmount(row.credit)}</td>
              <td className={styles.cellAmount}>{fmtAmount(row.balance)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Overview inner (reads useSearchParams) ────────────────────────────────────

function OverviewInner() {
  const searchParams = useSearchParams();
  const { t, lang } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [data, setData] = useState<OverviewData | null>(null);
  const [deadlines, setDeadlines] = useState<VidDeadline[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/overview?clientCompanyId=${encodeURIComponent(id)}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setData(await res.json());
      try {
        const dRes = await fetch(`/api/vid/deadlines?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (dRes.ok) setDeadlines(((await dRes.json()) as { deadlines: VidDeadline[] }).deadlines);
      } catch { /* strip is optional; ignore */ }
    } catch (err) {
      const e = err as Error;
      setError(e.message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('over.title')}</h1>

        {/* Error */}
        {error && (
          <ErrorState message={error} onRetry={() => clientCompanyId && load(clientCompanyId)} />
        )}

        {/* Loading */}
        {!error && loading && (
          <div className={styles.skeletons}>
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {/* Empty */}
        {!error && !loading && data && data.trialBalance.length === 0 && (
          <EmptyState
            message={t('over.empty')}
            detail={t('over.emptyDetail')}
          />
        )}

        {/* Data */}
        {!error && !loading && data && data.trialBalance.length > 0 && (
          <div className={styles.sections}>

            {/* VID deadline strip */}
            <section className={styles.section} aria-labelledby="vid-strip-heading">
              <h2 id="vid-strip-heading" className={styles.sectionHeading}>{t('vid.strip')}</h2>
              <p className={styles.stripHint}>{t('vid.stripHint')}</p>
              {(!deadlines || deadlines.length === 0) ? (
                <p className={styles.stripAllClear}>{t('vid.allClear')}</p>
              ) : (
                <ul className={styles.strip}>
                  {deadlines.map((d) => (
                    <li key={d.einvoiceId} className={d.overdue ? styles.stripItemOverdue : styles.stripItem}>
                      <span className={styles.stripInvoice}>{d.invoiceNumber}</span>
                      <span className={styles.stripDue}>
                        {(d.overdue ? t('vid.overdue') : t('vid.due')).replace(
                          '{date}',
                          new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short' }).format(new Date(d.dueDate)),
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* VAT position */}
            <section className={styles.section} aria-labelledby="vat-heading">
              <h2 id="vat-heading" className={styles.sectionHeading}>{t('over.vat')}</h2>
              <FigureRows
                rows={[
                  {
                    label: t('over.netPayable'),
                    value: formatDecimal(data.vat.netPayable) ?? data.vat.netPayable,
                  },
                ]}
                caption={[
                  data.vat.rule.value ? `${data.vat.rule.value} %` : null,
                  formatDateRange(data.period.fromDate, data.period.toDate),
                ].filter(Boolean).join(' · ') || undefined}
              />
            </section>

            {/* Receivables */}
            <section className={styles.section} aria-labelledby="rec-heading">
              <h2 id="rec-heading" className={styles.sectionHeading}>{t('over.receivables')}</h2>
              <FigureRows
                rows={[
                  {
                    label: t('over.receivables'),
                    value: formatCents(data.receivables.balanceCents) ?? '—',
                  },
                ]}
              />
            </section>

            {/* Trial balance */}
            <section className={styles.section} aria-labelledby="tb-heading">
              <h2 id="tb-heading" className={styles.sectionHeading}>{t('over.trialBalance')}</h2>
              <TrialBalanceTable rows={data.trialBalance} t={t} />
            </section>

          </div>
        )}
      </main>
    </div>
  );
}

// ── Skeleton fallback ─────────────────────────────────────────────────────────

function OverviewSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.skeletons}>
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
    <Suspense fallback={<OverviewSkeleton />}>
      <OverviewInner />
    </Suspense>
  );
}

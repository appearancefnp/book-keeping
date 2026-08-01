'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import type { MsgKey } from '@/app/lib/i18n';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { formatCents, formatDecimal } from '@/app/lib/format';
import { PaymentStatusBadge } from '@/app/components/PaymentStatusBadge';
import type { ReceivableStatus } from '@domain/receivables/receivables.js';
import styles from './page.module.css';

interface EinvoiceRow {
  id: string; direction: 'outbound' | 'inbound'; invoiceNumber: string; issueDate: string;
  grandTotalCents: string; currency: string; peppolStatus: string; peppolMessageId: string | null;
  vidStatus: string; vidDueDate: string | null;
  docType: 'invoice' | 'credit_note'; correctedInvoiceNumber: string | null;
  status: ReceivableStatus | null; dueDate: string | null;
  amountPaidCents: string | null; outstandingCents: string | null;
}

interface RecurringRow {
  id: string; customerPartyId: string; recipientPeppolId: string;
  anchorDay: number; intervalMonths: number; nextRunDate: string;
  paymentTermsDays: number | null; endDate: string | null;
  occurrencesRemaining: number | null; active: boolean;
  invoicePayload: { customer: { name: string }; grandTotal: string; currency: string };
}

function InvoicesInner() {
  const searchParams = useSearchParams();
  const { t, lang } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [rows, setRows] = useState<EinvoiceRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<'outbox' | 'recurring'>('outbox');
  const [templates, setTemplates] = useState<RecurringRow[] | null>(null);
  const [recError, setRecError] = useState<string | null>(null);

  const [settleRow, setSettleRow] = useState<EinvoiceRow | null>(null);
  const [amount, setAmount] = useState('');
  const [paidDate, setPaidDate] = useState('');
  const [settleError, setSettleError] = useState<string | null>(null);
  const [settleBusy, setSettleBusy] = useState(false);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/einvoices?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { einvoices: EinvoiceRow[] };
      setRows(body.einvoices);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  const loadTemplates = useCallback(async (id: string) => {
    setRecError(null);
    try {
      const res = await fetch(`/api/recurring?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { templates: RecurringRow[] };
      setTemplates(body.templates);
    } catch (err) {
      setRecError((err as Error).message ?? t('state.error'));
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId && tab === 'recurring' && templates === null) loadTemplates(clientCompanyId);
  }, [clientCompanyId, tab, templates, loadTemplates]);

  const pauseTemplate = async (id: string) => {
    if (!clientCompanyId) return;
    if (!confirm(t('einv.rec.pauseConfirm'))) return;
    setRecError(null);
    try {
      const res = await fetch(`/api/recurring/${id}?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setTemplates(null); // force a refetch through the effect above
    } catch (err) {
      setRecError((err as Error).message ?? t('state.error'));
    }
  };

  const cadenceLabel = (r: RecurringRow) =>
    r.intervalMonths === 1
      ? t('einv.rec.monthly').replace('{day}', String(r.anchorDay))
      : t('einv.rec.everyNMonths').replace('{n}', String(r.intervalMonths)).replace('{day}', String(r.anchorDay));

  const openSettle = (r: EinvoiceRow) => {
    setSettleRow(r);
    // Prefill amount to outstanding in major units (cents/100), date to today.
    setAmount(r.outstandingCents ? (Number(r.outstandingCents) / 100).toFixed(2) : '');
    setPaidDate(new Date().toISOString().slice(0, 10));
    setSettleError(null);
  };

  const submitSettle = async (action: 'settle' | 'void') => {
    if (!settleRow || !clientCompanyId) return;
    setSettleBusy(true);
    setSettleError(null);
    try {
      const body: Record<string, string> = { clientCompanyId, action };
      if (action === 'settle') {
        const parsed = Number(amount.trim().replace(',', '.'));
        if (!Number.isFinite(parsed) || parsed <= 0) {
          setSettleError(t('settle.invalidAmount'));
          setSettleBusy(false);
          return;
        }
        body.amountCents = String(Math.round(parsed * 100));
        body.paidDate = paidDate;
      }
      const res = await fetch(`/api/receivables/${encodeURIComponent(settleRow.id)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setSettleRow(null);
      await load(clientCompanyId);
    } catch (err) {
      setSettleError((err as Error).message);
    } finally {
      setSettleBusy(false);
    }
  };

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

  // Status keys are constrained by DB CHECKs; fall back to the raw value defensively.
  const statusLabel = (s: string) => {
    const key = `einv.status.${s}` as MsgKey;
    const label = t(key);
    return label === key ? s : label;
  };

  const docTypeLabel = (r: EinvoiceRow) => {
    if (r.docType === 'credit_note') {
      return r.correctedInvoiceNumber
        ? t('einv.docType.credits').replace('{number}', r.correctedInvoiceNumber)
        : t('einv.docType.creditNote');
    }
    return t('einv.docType.invoice');
  };

  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{t('einv.title')}</h1>
          <Link
            className={styles.primaryBtn}
            href={`/invoices/new${clientCompanyId ? `?client=${encodeURIComponent(clientCompanyId)}` : ''}`}
          >
            {t('einv.new')}
          </Link>
        </div>

        <div className={styles.tabs} role="tablist">
          <button role="tab" aria-selected={tab === 'outbox'}
                  className={tab === 'outbox' ? styles.tabActive : styles.tab}
                  onClick={() => setTab('outbox')}>
            {t('einv.tab.outbox')}
          </button>
          <button role="tab" aria-selected={tab === 'recurring'}
                  className={tab === 'recurring' ? styles.tabActive : styles.tab}
                  onClick={() => setTab('recurring')}>
            {t('einv.tab.recurring')}
          </button>
        </div>

        {tab === 'outbox' && (
          <>
        {error && <ErrorState message={error} onRetry={() => clientCompanyId && load(clientCompanyId)} />}
        {!error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}
        {!error && !loading && rows && rows.length === 0 && (
          <EmptyState message={t('einv.empty')} detail={t('einv.emptyDetail')} />
        )}
        {!error && !loading && rows && rows.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('einv.docType')}</th>
                  <th scope="col">{t('einv.number')}</th>
                  <th scope="col">{t('einv.issueDate')}</th>
                  <th scope="col" className={styles.colAmount}>{t('einv.total')}</th>
                  <th scope="col">{t('einv.peppol')}</th>
                  <th scope="col">{t('einv.vid')}</th>
                  <th scope="col">{t('einv.vidDue')}</th>
                  <th scope="col">{t('einv.payment')}</th>
                  <th scope="col">{t('einv.due')}</th>
                  <th scope="col" className={styles.colAmount}>{t('einv.outstanding')}</th>
                  <th scope="col"><span className="sr-only">{t('einv.viewDoc')}</span></th>
                  <th scope="col"><span className="sr-only">{t('settle.action')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{docTypeLabel(r)}</td>
                    <td className={styles.mono}>{r.invoiceNumber}</td>
                    <td>{fmtDate(r.issueDate)}</td>
                    <td className={styles.colAmount}>{formatCents(r.grandTotalCents, r.currency) ?? '—'}</td>
                    <td>{statusLabel(r.peppolStatus)}</td>
                    <td>{statusLabel(r.vidStatus)}</td>
                    <td>{r.vidDueDate ? fmtDate(r.vidDueDate) : '—'}</td>
                    <td>{r.direction === 'outbound' && r.status ? <PaymentStatusBadge status={r.status} /> : '—'}</td>
                    <td>{r.direction === 'outbound' && r.status && r.dueDate ? fmtDate(r.dueDate) : '—'}</td>
                    <td className={styles.colAmount}>
                      {r.direction === 'outbound' && r.status && r.status !== 'void' ? (formatCents(r.outstandingCents ?? '0', r.currency) ?? '—') : '—'}
                    </td>
                    <td>
                      {r.direction === 'outbound' && clientCompanyId ? (
                        <a
                          href={`/invoice-document/${r.id}?client=${encodeURIComponent(clientCompanyId)}&lang=${lang}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t('einv.viewDoc')}
                        </a>
                      ) : '—'}
                    </td>
                    <td>
                      {r.direction === 'outbound' && (r.status === 'open' || r.status === 'partially_paid') ? (
                        <button type="button" className={styles.linkBtn} onClick={() => openSettle(r)}>
                          {t('settle.action')}
                        </button>
                      ) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
          </>
        )}

        {tab === 'recurring' && (
          <>
            {recError && <ErrorState message={recError} onRetry={() => clientCompanyId && loadTemplates(clientCompanyId)} />}
            {!recError && templates === null && <SkeletonCard />}
            {!recError && templates?.length === 0 && (
              <EmptyState message={t('einv.rec.empty')} detail={t('einv.rec.emptyDetail')} />
            )}
            {!recError && templates && templates.length > 0 && (
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">{t('einv.rec.customer')}</th>
                      <th scope="col">{t('einv.rec.cadence')}</th>
                      <th scope="col">{t('einv.rec.nextRun')}</th>
                      <th scope="col" className={styles.colAmount}>{t('reports.col.amount')}</th>
                      <th scope="col">{t('einv.rec.state')}</th>
                      <th scope="col"><span className="sr-only">{t('einv.rec.pause')}</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map((r) => (
                      <tr key={r.id}>
                        <td>{r.invoicePayload.customer.name}</td>
                        <td>{cadenceLabel(r)}</td>
                        <td>{r.active ? fmtDate(r.nextRunDate) : '—'}</td>
                        <td className={styles.colAmount}>{formatDecimal(r.invoicePayload.grandTotal, r.invoicePayload.currency) ?? `${r.invoicePayload.grandTotal} ${r.invoicePayload.currency}`}</td>
                        <td>{t(r.active ? 'einv.rec.active' : 'einv.rec.paused')}</td>
                        <td>
                          {r.active && (
                            <button type="button" className={styles.linkBtn} onClick={() => pauseTemplate(r.id)}>
                              {t('einv.rec.pause')}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {settleRow && (
          <div
            className={styles.overlay}
            role="dialog"
            aria-modal="true"
            onClick={() => { if (!settleBusy) setSettleRow(null); }}
          >
            <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
              <h2>{t('settle.title')}</h2>
              <p className={styles.mono}>{settleRow.invoiceNumber}</p>
              <label>
                {t('settle.amount')}
                <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </label>
              <label>
                {t('settle.paidDate')}
                <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
              </label>
              {settleError && <p className={styles.settleError}>{settleError}</p>}
              <div className={styles.drawerActions}>
                <button type="button" onClick={() => setSettleRow(null)} disabled={settleBusy}>{t('settle.cancel')}</button>
                {settleRow.status === 'open' && (
                  <button type="button" onClick={() => submitSettle('void')} disabled={settleBusy}>{t('settle.void')}</button>
                )}
                <button type="button" className={styles.primaryBtn} onClick={() => submitSettle('settle')} disabled={settleBusy}>
                  {t('settle.submit')}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function InvoicesSkeleton() {
  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </section>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<InvoicesSkeleton />}>
      <InvoicesInner />
    </Suspense>
  );
}

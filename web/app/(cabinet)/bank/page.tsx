'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import type { MsgKey } from '@/app/lib/i18n';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { formatCents } from '@/app/lib/format';
import { FeedsSection } from './FeedsSection';
import styles from './page.module.css';

interface BankTransactionRow {
  id: string; account: string; bookingDate: string; amountCents: string; currency: string;
  side: 'credit' | 'debit'; reference: string; counterparty: string; status: string; matchedEntryId: string | null;
}
interface PaymentDraft { iban: string; amount: string; reference: string; }

function BankInner() {
  const searchParams = useSearchParams();
  const { t, lang } = useMessages();
  const clientCompanyId = searchParams.get('client');
  const fileInput = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<BankTransactionRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [payments, setPayments] = useState<PaymentDraft[]>([{ iban: '', amount: '', reference: '' }]);
  const [generating, setGenerating] = useState(false);
  const [orderMsg, setOrderMsg] = useState<string | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/bank/transactions?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setRows(((await res.json()) as { transactions: BankTransactionRow[] }).transactions);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  async function importFile(file: File) {
    if (!clientCompanyId) return;
    setImporting(true);
    setImportMsg(null);
    setImportError(null);
    try {
      const xml = await file.text();
      const res = await fetch('/api/bank/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, xml }),
      });
      const body = (await res.json().catch(() => ({}))) as { imported?: number; skipped?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setImportMsg(
        t('bankpage.imported')
          .replace('{imported}', String(body.imported ?? 0))
          .replace('{skipped}', String(body.skipped ?? 0)),
      );
      await load(clientCompanyId);
    } catch (err) {
      setImportError((err as Error).message ?? t('state.error'));
    } finally {
      setImporting(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function generateOrder() {
    if (!clientCompanyId) return;
    setGenerating(true);
    setOrderMsg(null);
    setOrderError(null);
    try {
      const res = await fetch('/api/bank/payment-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, payments }),
      });
      const body = (await res.json().catch(() => ({}))) as { xml?: string; error?: string };
      if (!res.ok || !body.xml) throw new Error(body.error ?? `HTTP ${res.status}`);
      const blob = new Blob([body.xml], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'pain001.xml';
      a.click();
      URL.revokeObjectURL(url);
      setOrderMsg(t('bankpage.generated'));
    } catch (err) {
      setOrderError((err as Error).message ?? t('state.error'));
    } finally {
      setGenerating(false);
    }
  }

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  const statusLabel = (s: string) => {
    const key = `bankpage.status.${s}` as MsgKey;
    const label = t(key);
    return label === key ? s : label;
  };
  const signedAmount = (r: BankTransactionRow) => {
    const n = formatCents(r.amountCents, r.currency) ?? '—';
    return r.side === 'debit' ? `−${n}` : n;
  };
  const canGenerate = payments.some((p) => p.iban.trim() && Number(p.amount) > 0);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('bankpage.title')}</h1>

        {clientCompanyId && <FeedsSection clientCompanyId={clientCompanyId} />}

        <section className={styles.card} aria-labelledby="upload-heading">
          <h2 id="upload-heading" className={styles.sectionHeading}>{t('bankpage.upload')}</h2>
          <p className={styles.hint}>{t('bankpage.uploadHint')}</p>
          <input
            ref={fileInput}
            type="file"
            accept=".xml,text/xml,application/xml"
            className="sr-only"
            id="camt-file"
            disabled={importing}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) importFile(f); }}
          />
          <label htmlFor="camt-file" className={styles.primaryBtn} aria-disabled={importing}>
            {importing ? t('state.loading') : t('bankpage.choose')}
          </label>
          {importMsg && <p className={styles.okMsg} role="status">{importMsg}</p>}
          {importError && <p className={styles.formError} role="alert">{importError}</p>}
        </section>

        <section className={styles.card} aria-labelledby="txns-heading">
          <h2 id="txns-heading" className={styles.sectionHeading}>{t('bankpage.transactions')}</h2>
          <p className={styles.hint}>{t('bankpage.matchHint')}</p>
          {error && <ErrorState message={error} onRetry={() => clientCompanyId && load(clientCompanyId)} />}
          {!error && loading && <div className={styles.skeletons}><SkeletonCard /></div>}
          {!error && !loading && rows && rows.length === 0 && (
            <EmptyState message={t('bankpage.empty')} detail={t('bankpage.emptyDetail')} />
          )}
          {!error && !loading && rows && rows.length > 0 && (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t('bankpage.date')}</th>
                    <th scope="col">{t('bankpage.counterparty')}</th>
                    <th scope="col">{t('bankpage.reference')}</th>
                    <th scope="col" className={styles.colAmount}>{t('bankpage.amount')}</th>
                    <th scope="col">{t('bankpage.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{fmtDate(r.bookingDate)}</td>
                      <td>{r.counterparty || '—'}</td>
                      <td>{r.reference || '—'}</td>
                      <td className={styles.colAmount}>{signedAmount(r)}</td>
                      <td>{statusLabel(r.status)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className={styles.card} aria-labelledby="orders-heading">
          <h2 id="orders-heading" className={styles.sectionHeading}>{t('bankpage.orders')}</h2>
          <p className={styles.hint}>{t('bankpage.ordersHint')}</p>
          {payments.map((p, i) => (
            <div key={i} className={styles.paymentRow}>
              <label className={styles.field}>
                <span>{t('bankpage.iban')}</span>
                <input value={p.iban} onChange={(e) => setPayments(payments.map((x, j) => (j === i ? { ...x, iban: e.target.value } : x)))} />
              </label>
              <label className={styles.field}>
                <span>{t('bankpage.orderAmount')}</span>
                <input inputMode="decimal" value={p.amount} onChange={(e) => setPayments(payments.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              </label>
              <label className={styles.field}>
                <span>{t('bankpage.orderReference')}</span>
                <input value={p.reference} onChange={(e) => setPayments(payments.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))} />
              </label>
              <button type="button" className={styles.ghostBtn} onClick={() => setPayments(payments.filter((_, j) => j !== i))} disabled={payments.length === 1}>
                {t('bankpage.removePayment')}
              </button>
            </div>
          ))}
          <div className={styles.formActions}>
            <button type="button" className={styles.ghostBtn} onClick={() => setPayments([...payments, { iban: '', amount: '', reference: '' }])}>
              {t('bankpage.addPayment')}
            </button>
            <button type="button" className={styles.primaryBtn} onClick={generateOrder} disabled={!canGenerate || generating}>
              {t('bankpage.generate')}
            </button>
          </div>
          {orderMsg && <p className={styles.okMsg} role="status">{orderMsg}</p>}
          {orderError && <p className={styles.formError} role="alert">{orderError}</p>}
        </section>
      </main>
    </div>
  );
}

function BankSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<BankSkeleton />}>
      <BankInner />
    </Suspense>
  );
}

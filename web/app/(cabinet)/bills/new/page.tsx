'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import styles from './page.module.css';

interface Vendor { id: string; name: string; }
interface Line { description: string; expenseAccount: string; net: string; vatRate: number; vat: string; }

const emptyLine = (): Line => ({ description: '', expenseAccount: '7710', net: '0.00', vatRate: 21, vat: '0.00' });
function round2(n: number): string { return (Math.round(n * 100) / 100).toFixed(2); }

function NewBillInner() {
  const { t } = useMessages();
  const router = useRouter();
  const params = useSearchParams();
  const client = params.get('client');

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [vendorPartyId, setVendorPartyId] = useState('');
  const [billNumber, setBillNumber] = useState('');
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<Line[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!client) return;
    fetch(`/api/parties?clientCompanyId=${encodeURIComponent(client)}&kind=vendor`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { parties?: Vendor[] }) => setVendors(d.parties ?? []))
      .catch(() => {});
  }, [client]);

  const totals = useMemo(() => {
    const net = lines.reduce((a, l) => a + Number(l.net || 0), 0);
    const vat = lines.reduce((a, l) => a + Number(l.vat || 0), 0);
    return { net, vat, grand: net + vat };
  }, [lines]);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => {
      if (j !== i) return l;
      const next = { ...l, ...patch };
      if (patch.net !== undefined || patch.vatRate !== undefined) {
        next.vat = round2((Number(next.net) || 0) * next.vatRate / 100);
      }
      return next;
    }));

  const submit = useCallback(async () => {
    if (!client) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/bills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, vendorPartyId, billNumber, issueDate, dueDate, currency: 'EUR', lines }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      router.push(`/bills?client=${encodeURIComponent(client)}`);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
      setSaving(false);
    }
  }, [client, vendorPartyId, billNumber, issueDate, dueDate, lines, router, t]);

  const valid = !!vendorPartyId && !!billNumber.trim() && lines.length > 0 && lines.every((l) => l.description.trim());

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1 className={styles.pageHeading}>{t('bills.new')}</h1>

        <div className={styles.fields}>
          <label className={styles.field}>
            {t('bills.vendor')}
            <select value={vendorPartyId} onChange={(e) => setVendorPartyId(e.target.value)}>
              <option value="">—</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            {t('bills.number')}
            <input value={billNumber} onChange={(e) => setBillNumber(e.target.value)} />
          </label>
          <label className={styles.field}>
            {t('bills.issueDate')}
            <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          </label>
          <label className={styles.field}>
            {t('bills.dueDate')}
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
        </div>

        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('bills.description')}</th>
              <th scope="col">{t('bills.account')}</th>
              <th scope="col" className={styles.right}>{t('bills.net')}</th>
              <th scope="col" className={styles.right}>{t('bills.vatRate')}</th>
              <th scope="col" className={styles.right}>{t('bills.vat')}</th>
              <th scope="col"><span className="sr-only">{t('bills.removeLine')}</span></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <input
                    aria-label={t('bills.description')}
                    value={l.description}
                    onChange={(e) => setLine(i, { description: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    aria-label={t('bills.account')}
                    value={l.expenseAccount}
                    onChange={(e) => setLine(i, { expenseAccount: e.target.value })}
                    className={styles.acct}
                  />
                </td>
                <td className={styles.right}>
                  <input
                    aria-label={t('bills.net')}
                    inputMode="decimal"
                    value={l.net}
                    onChange={(e) => setLine(i, { net: e.target.value })}
                    className={styles.num}
                  />
                </td>
                <td className={styles.right}>
                  <input
                    aria-label={t('bills.vatRate')}
                    inputMode="numeric"
                    value={String(l.vatRate)}
                    onChange={(e) => setLine(i, { vatRate: Number(e.target.value) || 0 })}
                    className={styles.num}
                  />
                </td>
                <td className={styles.right}>{l.vat}</td>
                <td>
                  {lines.length > 1 && (
                    <button type="button" className={styles.ghostBtn} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                      {t('bills.removeLine')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className={styles.addLine} onClick={() => setLines((ls) => [...ls, emptyLine()])}>
          {t('bills.addLine')}
        </button>

        <div className={styles.totals}>
          <div><span>{t('bills.net')}</span><span className={styles.right}>{round2(totals.net)}</span></div>
          <div><span>{t('bills.vat')}</span><span className={styles.right}>{round2(totals.vat)}</span></div>
          <div className={styles.grand}><span>{t('bills.total')}</span><span className={styles.right}>{round2(totals.grand)}</span></div>
        </div>

        {error && <p className={styles.formError} role="alert">{error}</p>}
        <button type="button" className={styles.submit} disabled={!valid || saving} onClick={submit}>
          {t('bills.submit')}
        </button>
      </main>
    </div>
  );
}

function NewBillSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <SkeletonCard />
      </main>
    </div>
  );
}

export default function NewBillPage() {
  return (
    <Suspense fallback={<NewBillSkeleton />}>
      <NewBillInner />
    </Suspense>
  );
}

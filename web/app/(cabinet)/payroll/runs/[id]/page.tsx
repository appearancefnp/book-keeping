'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { formatDecimal } from '@/app/lib/format';
import { PayrollTabs } from '../../PayrollTabs';
import styles from '../../payroll.module.css';

interface Item {
  employeeId: string; gross: string; net: string; payout: string;
  base: string; premiums: string; bonus: string; vacationPay: string; sickPay: string;
  vsaoiEmployee: string; iin: string; otherDeductions: string; vsaoiEmployer: string; riskDuty: string;
  warnings: string[]; explanation: { step: string; amount: string }[];
}
interface RunData { id: string; year: number; month: number; status: 'draft' | 'computed' | 'approved'; items: Item[] }
interface EmployeeRow { id: string; firstName: string; lastName: string; }

function RunInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const client = searchParams.get('client');

  const [run, setRun] = useState<RunData | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Item | null>(null);

  const load = useCallback(async (cid: string) => {
    setLoading(true); setError(null);
    try {
      const [rRes, eRes] = await Promise.all([
        fetch(`/api/payroll/runs/${id}?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' }),
        fetch(`/api/payroll/employees?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' }),
      ]);
      if (!rRes.ok) throw new Error((await rRes.json().catch(() => ({}))).error ?? `HTTP ${rRes.status}`);
      if (!eRes.ok) throw new Error((await eRes.json().catch(() => ({}))).error ?? `HTTP ${eRes.status}`);
      setRun((await rRes.json()).run);
      const emps = (await eRes.json()).employees as EmployeeRow[];
      setNames(Object.fromEntries(emps.map((e) => [e.id, `${e.lastName} ${e.firstName}`])));
    } catch (err) { setError((err as Error).message); } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { if (client) load(client); }, [client, load]);

  async function act(path: string, okMsg: string) {
    if (!client) return;
    setBusy(true); setMsg(null); setError(null);
    try {
      const res = await fetch(`/api/payroll/runs/${id}/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientCompanyId: client }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setMsg(okMsg); await load(client);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  const warnLabel = (w: string) => { const k = `pay.warn.${w}`; const s = t(k as never); return s === k ? w : s; };
  const name = (eid: string) => names[eid] ?? eid;

  const exceptions = useMemo(() => run?.items.filter((i) => i.warnings.length > 0) ?? [], [run]);

  if (!client) return <div className={styles.page}><section className={styles.main}><PayrollTabs client={null} /></section></div>;

  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>
            {run ? `${run.year}-${String(run.month).padStart(2, '0')}` : t('pay.run.title')}
            {run && <span className={styles.statusChip} style={{ marginLeft: 12 }}>{t(`pay.run.status.${run.status}` as never)}</span>}
          </h1>
          <Link className={styles.ghostBtn} href={`/payroll/runs?client=${encodeURIComponent(client)}`}>{t('pay.run.close')}</Link>
        </div>
        <PayrollTabs client={client} />
        {msg && <p className={styles.hint} role="status">{msg}</p>}
        {error && <ErrorState message={error} onRetry={() => load(client)} />}
        {loading && <div className={styles.skeletons}><SkeletonCard /></div>}

        {run && (
          <>
            <div className={styles.rowActions}>
              {run.status !== 'approved' && (
                <button className={styles.primaryBtn} disabled={busy} onClick={() => act('compute', t('pay.run.computed'))}>
                  {run.status === 'draft' ? t('pay.run.compute') : t('pay.run.recompute')}
                </button>
              )}
              {run.status === 'computed' && (
                <button className={styles.primaryBtn} disabled={busy} onClick={() => act('approve', t('pay.run.approved'))}>
                  {t('pay.run.approve')}
                </button>
              )}
            </div>

            {run.items.length > 0 && (
              <section className={styles.section}>
                <h2 className={styles.sectionTitle}>{t('pay.run.exceptions')}</h2>
                {exceptions.length === 0
                  ? <p className={styles.okNote}>{t('pay.run.clean')}</p>
                  : (
                    <>
                      <p className={styles.hint}>{t('pay.run.exceptionsDetail')}</p>
                      {exceptions.map((i) => (
                        <div key={i.employeeId} className={styles.exceptionCard}>
                          <div className={styles.headRow}>
                            <strong>{name(i.employeeId)}</strong>
                            <button className={styles.ghostBtn} onClick={() => setDetail(i)}>{t('pay.run.detail')}</button>
                          </div>
                          <div className={styles.warnList}>
                            {i.warnings.map((w) => <span key={w} className={styles.warnBadge}>{warnLabel(w)}</span>)}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
              </section>
            )}

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('pay.run.allItems')}</h2>
              <div className={styles.tableWrapper}>
                <table className={styles.table}>
                  <thead><tr>
                    <th scope="col">{t('pay.run.employee')}</th>
                    <th scope="col" className={styles.num}>{t('pay.run.gross')}</th>
                    <th scope="col" className={styles.num}>{t('pay.run.net')}</th>
                    <th scope="col" className={styles.num}>{t('pay.run.payout')}</th>
                    <th scope="col">{t('pay.run.warnings')}</th>
                    <th scope="col"><span className="sr-only">{t('pay.run.detail')}</span></th>
                  </tr></thead>
                  <tbody>
                    {run.items.map((i) => (
                      <tr key={i.employeeId} className={i.warnings.length > 0 ? styles.warnRow : undefined}>
                        <td>{name(i.employeeId)}</td>
                        <td className={styles.num}>{formatDecimal(i.gross)}</td>
                        <td className={styles.num}>{formatDecimal(i.net)}</td>
                        <td className={styles.num}>{formatDecimal(i.payout)}</td>
                        <td>{i.warnings.length > 0 ? i.warnings.length : '—'}</td>
                        <td className={styles.actionsCell}>
                          <button className={styles.ghostBtn} onClick={() => setDetail(i)}>{t('pay.run.detail')}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {detail && (
          <div className={styles.drawer} role="dialog" aria-modal="true" onClick={() => setDetail(null)}>
            <div className={styles.drawerPanel} onClick={(e) => e.stopPropagation()}>
              <div className={styles.headRow}>
                <h2 className={styles.sectionTitle}>{name(detail.employeeId)}</h2>
                <button className={styles.ghostBtn} onClick={() => setDetail(null)}>{t('pay.run.close')}</button>
              </div>
              {detail.warnings.length > 0 && (
                <div className={styles.warnList}>
                  {detail.warnings.map((w) => <span key={w} className={styles.warnBadge}>{warnLabel(w)}</span>)}
                </div>
              )}
              <h3 className={styles.hint}>{t('pay.run.explanation')}</h3>
              <div className={styles.explain}>
                {detail.explanation.map((line, idx) => (
                  <div key={idx} className={styles.explainRow}><span>{line.step}</span><span>{formatDecimal(line.amount)}</span></div>
                ))}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className={styles.skeletons}><SkeletonCard /></div>}><RunInner /></Suspense>;
}

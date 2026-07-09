'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { formatDecimal } from '@/app/lib/format';
import { PayrollTabs } from './PayrollTabs';
import styles from './payroll.module.css';

interface EmployeeRow {
  id: string; firstName: string; lastName: string; personalCode: string; position: string;
  wageType: 'monthly' | 'hourly'; wage: string; hiredOn: string; terminatedOn: string | null;
}
type ContractType = 'indefinite' | 'fixed_term';
type WageType = 'monthly' | 'hourly';
interface FormState {
  firstName: string; lastName: string; personalCode: string; position: string;
  contractNo: string; contractDate: string; contractType: ContractType;
  wageType: WageType; wage: string; hiredOn: string;
  openingVacationDays: string; openingBalanceDate: string;
}
const EMPTY_FORM: FormState = {
  firstName: '', lastName: '', personalCode: '', position: '',
  contractNo: '', contractDate: '', contractType: 'indefinite',
  wageType: 'monthly', wage: '', hiredOn: '', openingVacationDays: '0', openingBalanceDate: '',
};

function EmployeesInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const client = searchParams.get('client');

  const [rows, setRows] = useState<EmployeeRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true); setError(null);
    try {
      const res = await fetch(`/api/payroll/employees?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setRows((await res.json()).employees);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally { setLoading(false); }
  }, [t]);

  useEffect(() => { if (client) load(client); }, [client, load]);

  async function save() {
    if (!client || !form) return;
    setSaving(true); setSaveError(null);
    try {
      const res = await fetch('/api/payroll/employees', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, employee: form }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setForm(null); await load(client);
    } catch (err) {
      setSaveError((err as Error).message ?? t('state.error'));
    } finally { setSaving(false); }
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{t('pay.title')}</h1>
          {client && (
            <button type="button" className={styles.primaryBtn} onClick={() => { setSaveError(null); setForm({ ...EMPTY_FORM }); }}>
              {t('pay.emp.new')}
            </button>
          )}
        </div>
        <PayrollTabs client={client} />

        {!client && <EmptyState message={t('pay.selectClient')} />}

        {client && form && (
          <form className={styles.form} onSubmit={(e) => { e.preventDefault(); save(); }}>
            {([
              ['firstName', 'text'], ['lastName', 'text'], ['personalCode', 'text'], ['position', 'text'],
              ['contractNo', 'text'], ['contractDate', 'date'], ['hiredOn', 'date'],
              ['wage', 'text'], ['openingVacationDays', 'text'], ['openingBalanceDate', 'date'],
            ] as [keyof FormState, string][]).map(([key, type]) => (
              <label key={key} className={styles.field}>
                <span>{t(`pay.emp.${key === 'firstName' || key === 'lastName' ? 'name' : key}` as never)}</span>
                <input type={type} value={form[key]} required={key !== 'openingVacationDays'}
                  onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
              </label>
            ))}
            <label className={styles.field}>
              <span>{t('pay.emp.contractType')}</span>
              <select value={form.contractType} onChange={(e) => setForm({ ...form, contractType: e.target.value as ContractType })}>
                <option value="indefinite">{t('pay.emp.contractType.indefinite')}</option>
                <option value="fixed_term">{t('pay.emp.contractType.fixed_term')}</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('pay.emp.wageType')}</span>
              <select value={form.wageType} onChange={(e) => setForm({ ...form, wageType: e.target.value as WageType })}>
                <option value="monthly">{t('pay.emp.wageType.monthly')}</option>
                <option value="hourly">{t('pay.emp.wageType.hourly')}</option>
              </select>
            </label>
            {saveError && <p className={styles.formError} role="alert">{saveError}</p>}
            <div className={styles.formActions}>
              <button type="submit" className={styles.primaryBtn} disabled={saving}>{t('pay.emp.save')}</button>
              <button type="button" className={styles.ghostBtn} onClick={() => setForm(null)}>{t('pay.emp.cancel')}</button>
            </div>
          </form>
        )}

        {client && error && <ErrorState message={error} onRetry={() => load(client)} />}
        {client && !error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}
        {client && !error && !loading && rows && rows.length === 0 && (
          <EmptyState message={t('pay.emp.empty')} detail={t('pay.emp.emptyDetail')} />
        )}
        {client && !error && !loading && rows && rows.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('pay.emp.name')}</th>
                  <th scope="col">{t('pay.emp.position')}</th>
                  <th scope="col">{t('pay.emp.wage')}</th>
                  <th scope="col">{t('pay.emp.contractType')}</th>
                  <th scope="col"><span className="sr-only">{t('pay.emp.open')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td>{e.lastName} {e.firstName}{e.terminatedOn ? ` · ${t('pay.emp.terminated')}` : ''}</td>
                    <td>{e.position}</td>
                    <td className={styles.num}>{formatDecimal(e.wage)}{e.wageType === 'hourly' ? '/h' : ''}</td>
                    <td>{e.wageType === 'monthly' ? t('pay.emp.wageType.monthly') : t('pay.emp.wageType.hourly')}</td>
                    <td className={styles.actionsCell}>
                      <Link className={styles.ghostBtn} href={`/payroll/employees/${e.id}?client=${encodeURIComponent(client)}`}>
                        {t('pay.emp.open')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className={styles.skeletons}><SkeletonCard /></div>}><EmployeesInner /></Suspense>;
}

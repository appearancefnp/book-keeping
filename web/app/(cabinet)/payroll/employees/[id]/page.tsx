'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { PayrollTabs } from '../../PayrollTabs';
import styles from '../../payroll.module.css';

interface EmployeeRow {
  id: string; firstName: string; lastName: string; personalCode: string; position: string;
  wageType: 'monthly' | 'hourly'; wage: string; hiredOn: string; terminatedOn: string | null;
  userId: string | null; iban: string | null;
}
interface UserOption { id: string; email: string; role: string; }
type MoneyKind = 'bonus' | 'other_taxable' | 'deduction';
type AbsenceType = 'vacation' | 'sick_a' | 'sick_b' | 'unpaid' | 'other';

function post(url: string, body: unknown) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function DetailInner() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const client = searchParams.get('client');

  const [emp, setEmp] = useState<EmployeeRow | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [users, setUsers] = useState<UserOption[]>([]);

  const [wage, setWage] = useState(''); const [position, setPosition] = useState('');
  const [userId, setUserId] = useState(''); const [iban, setIban] = useState('');
  const now = new Date();
  const [period, setPeriod] = useState(`${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`);
  const [bookActive, setBookActive] = useState(true);
  const [dependents, setDependents] = useState('0'); const [disability, setDisability] = useState('0');
  const [pensioner, setPensioner] = useState(false); const [repressed, setRepressed] = useState(false);
  const [kind, setKind] = useState<MoneyKind>('bonus'); const [amount, setAmount] = useState(''); const [compReason, setCompReason] = useState('');
  const [absType, setAbsType] = useState<AbsenceType>('unpaid'); const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [absReason, setAbsReason] = useState('');

  const load = useCallback(async (cid: string) => {
    setLoading(true); setError(null);
    try {
      // No single-employee GET endpoint: load the list and pick this id.
      const res = await fetch(`/api/payroll/employees?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const found = ((await res.json()).employees as EmployeeRow[]).find((e) => e.id === id) ?? null;
      if (!found) throw new Error('Employee not found');
      setEmp(found); setWage(found.wage); setPosition(found.position);
      setUserId(found.userId ?? ''); setIban(found.iban ?? '');
    } catch (err) { setError((err as Error).message); } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { if (client) load(client); }, [client, load]);

  useEffect(() => {
    // Client-side roles only (employee, owner) are eligible to be linked to an employee record.
    fetch('/api/admin/users', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { users: [] }))
      .then((data) => setUsers(((data.users ?? []) as UserOption[]).filter((u) => u.role === 'employee' || u.role === 'owner')))
      .catch(() => setUsers([]));
  }, []);

  async function run(fn: () => Promise<Response>, okMsg: string) {
    if (!client) return;
    setMsg(null); setError(null);
    try {
      const res = await fn();
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setMsg(okMsg); await load(client);
    } catch (err) { setError((err as Error).message); }
  }

  const [y, m] = period.split('-').map(Number);

  if (!client) return <div className={styles.page}><section className={styles.main}><PayrollTabs client={null} /><EmptyState message={t('pay.selectClient')} /></section></div>;

  return (
    <div className={styles.page}>
      <section className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{emp ? `${emp.lastName} ${emp.firstName}` : t('pay.emp.title')}</h1>
          <Link className={styles.ghostBtn} href={`/payroll?client=${encodeURIComponent(client)}`}>{t('pay.run.close')}</Link>
        </div>
        <PayrollTabs client={client} />
        {msg && <p className={styles.hint} role="status">{msg}</p>}
        {error && <ErrorState message={error} onRetry={() => load(client)} />}
        {loading && <div className={styles.skeletons}><SkeletonCard /></div>}

        {emp && (
          <>
            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('pay.emp.edit')}</h2>
              <form className={styles.form} onSubmit={(e) => { e.preventDefault(); run(
                () => fetch(`/api/payroll/employees/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientCompanyId: client, wage, position, userId: userId || null, iban: iban.trim() || null }) }),
                t('pay.emp.save'));
              }}>
                <label className={styles.field}><span>{t('pay.emp.wage')}</span>
                  <input value={wage} onChange={(e) => setWage(e.target.value)} /></label>
                <label className={styles.field}><span>{t('pay.emp.position')}</span>
                  <input value={position} onChange={(e) => setPosition(e.target.value)} /></label>
                <label className={styles.field}><span>{t('pay.emp.userLink')}</span>
                  <select value={userId} onChange={(e) => setUserId(e.target.value)}>
                    <option value="">{t('pay.emp.userLink.none')}</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
                  </select></label>
                <label className={styles.field}><span>{t('pay.emp.iban')}</span>
                  <input value={iban} onChange={(e) => setIban(e.target.value)} /></label>
                <div className={styles.formActions}><button className={styles.primaryBtn} type="submit">{t('pay.emp.save')}</button></div>
              </form>
            </section>

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('pay.tax.title')}</h2>
              <p className={styles.hint}>{t('pay.tax.hint')}</p>
              <form className={styles.form} onSubmit={(e) => { e.preventDefault(); run(
                () => post(`/api/payroll/employees/${id}/tax-status`, { clientCompanyId: client, year: y, month: m, taxBookActive: bookActive, dependents: Number(dependents), disabilityGroup: Number(disability), isPensioner: pensioner, isRepressed: repressed }),
                t('pay.tax.save'));
              }}>
                <label className={styles.field}><span>{t('pay.tax.period')}</span>
                  <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required /></label>
                <label className={`${styles.field} ${styles.checkField}`}>
                  <input type="checkbox" checked={bookActive} onChange={(e) => setBookActive(e.target.checked)} />
                  <span>{t('pay.tax.bookActive')}</span></label>
                <label className={styles.field}><span>{t('pay.tax.dependents')}</span>
                  <input type="number" min="0" value={dependents} onChange={(e) => setDependents(e.target.value)} /></label>
                <label className={styles.field}><span>{t('pay.tax.disability')}</span>
                  <select value={disability} onChange={(e) => setDisability(e.target.value)}>
                    <option value="0">{t('pay.tax.none')}</option><option value="1">I</option><option value="2">II</option><option value="3">III</option>
                  </select></label>
                <label className={`${styles.field} ${styles.checkField}`}>
                  <input type="checkbox" checked={pensioner} onChange={(e) => setPensioner(e.target.checked)} />
                  <span>{t('pay.tax.pensioner')}</span></label>
                <label className={`${styles.field} ${styles.checkField}`}>
                  <input type="checkbox" checked={repressed} onChange={(e) => setRepressed(e.target.checked)} />
                  <span>{t('pay.tax.repressed')}</span></label>
                <div className={styles.formActions}><button className={styles.primaryBtn} type="submit">{t('pay.tax.save')}</button></div>
              </form>
            </section>

            <section className={styles.section}>
              <h2 className={styles.sectionTitle}>{t('pay.adj.title')}</h2>
              <p className={styles.hint}>{t('pay.adj.hint')}</p>
              <form className={styles.form} onSubmit={(e) => {
                e.preventDefault();
                if (!compReason.trim()) { setError(t('pay.adj.needReason')); return; }
                run(() => post(`/api/payroll/employees/${id}/components`, { clientCompanyId: client, year: y, month: m, kind, amount, reason: compReason }), t('pay.adj.add'));
                setAmount(''); setCompReason('');
              }}>
                <label className={styles.field}><span>{t('pay.tax.period')}</span>
                  <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required /></label>
                <label className={styles.field}><span>{t('pay.adj.kind')}</span>
                  <select value={kind} onChange={(e) => setKind(e.target.value as MoneyKind)}>
                    <option value="bonus">{t('pay.ord.type.bonus')}</option>
                    <option value="other_taxable">other_taxable</option>
                    <option value="deduction">deduction</option>
                  </select></label>
                <label className={styles.field}><span>{t('pay.adj.amount')}</span>
                  <input value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
                <label className={styles.field}><span>{t('pay.adj.reason')}</span>
                  <input value={compReason} onChange={(e) => setCompReason(e.target.value)} required /></label>
                <div className={styles.formActions}><button className={styles.primaryBtn} type="submit">{t('pay.adj.add')}</button></div>
              </form>
              <form className={styles.form} onSubmit={(e) => {
                e.preventDefault();
                run(() => post(`/api/payroll/employees/${id}/absences`, { clientCompanyId: client, type: absType, dateFrom: from, dateTo: to, reason: absReason }), t('pay.adj.addAbsence'));
                setFrom(''); setTo(''); setAbsReason('');
              }}>
                <label className={styles.field}><span>{t('pay.adj.absenceType')}</span>
                  <select value={absType} onChange={(e) => setAbsType(e.target.value as AbsenceType)}>
                    <option value="vacation">{t('pay.ord.type.vacation')}</option>
                    <option value="sick_a">sick_a</option><option value="sick_b">sick_b</option>
                    <option value="unpaid">unpaid</option><option value="other">other</option>
                  </select></label>
                <label className={styles.field}><span>{t('pay.adj.from')}</span>
                  <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
                <label className={styles.field}><span>{t('pay.adj.to')}</span>
                  <input type="date" value={to} onChange={(e) => setTo(e.target.value)} required /></label>
                <label className={styles.field}><span>{t('pay.adj.reason')}</span>
                  <input value={absReason} onChange={(e) => setAbsReason(e.target.value)} /></label>
                <div className={styles.formActions}><button className={styles.ghostBtn} type="submit">{t('pay.adj.addAbsence')}</button></div>
              </form>
            </section>
          </>
        )}
      </section>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className={styles.skeletons}><SkeletonCard /></div>}><DetailInner /></Suspense>;
}

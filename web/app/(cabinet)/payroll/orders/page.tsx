'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { formatDecimal } from '@/app/lib/format';
import { PayrollTabs } from '../PayrollTabs';
import styles from '../payroll.module.css';

type OrderType = 'hire' | 'termination' | 'bonus' | 'vacation' | 'wage_change';
interface OrderRow {
  id: string; orderType: OrderType; status: 'draft' | 'approved'; employeeIds: string[];
  amount: string | null; dateFrom: string | null; dateTo: string | null; effectiveDate: string; reason: string;
}
interface EmployeeRow { id: string; firstName: string; lastName: string; }

const AMOUNT_TYPES = new Set<OrderType>(['bonus', 'wage_change']);
const RANGE_TYPES = new Set<OrderType>(['vacation', 'termination']);

function OrdersInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const client = searchParams.get('client');

  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [emps, setEmps] = useState<EmployeeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const [orderType, setOrderType] = useState<OrderType>('bonus');
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [amount, setAmount] = useState(''); const [dateFrom, setDateFrom] = useState(''); const [dateTo, setDateTo] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(''); const [reason, setReason] = useState(''); const [severance, setSeverance] = useState(false);

  const load = useCallback(async (cid: string) => {
    setLoading(true); setError(null);
    try {
      const [oRes, eRes] = await Promise.all([
        fetch(`/api/payroll/orders?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' }),
        fetch(`/api/payroll/employees?clientCompanyId=${encodeURIComponent(cid)}`, { cache: 'no-store' }),
      ]);
      if (!oRes.ok) throw new Error((await oRes.json().catch(() => ({}))).error ?? `HTTP ${oRes.status}`);
      if (!eRes.ok) throw new Error((await eRes.json().catch(() => ({}))).error ?? `HTTP ${eRes.status}`);
      setOrders((await oRes.json()).orders);
      setEmps((await eRes.json()).employees);
    } catch (err) { setError((err as Error).message); } finally { setLoading(false); }
  }, []);

  useEffect(() => { if (client) load(client); }, [client, load]);

  async function create() {
    if (!client) return;
    setMsg(null); setError(null);
    const order: Record<string, unknown> = { orderType, employeeIds, effectiveDate, reason };
    if (AMOUNT_TYPES.has(orderType)) order.amount = amount;
    if (RANGE_TYPES.has(orderType)) { order.dateFrom = dateFrom; order.dateTo = dateTo; }
    if (orderType === 'termination') order.payload = { severance };
    try {
      const res = await fetch('/api/payroll/orders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, order }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setOpen(false); setEmployeeIds([]); setAmount(''); setDateFrom(''); setDateTo(''); setEffectiveDate(''); setReason(''); setSeverance(false);
      await load(client);
    } catch (err) { setError((err as Error).message); }
  }

  async function approve(id: string) {
    if (!client) return;
    setMsg(null); setError(null);
    try {
      const res = await fetch(`/api/payroll/orders/${id}/approve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientCompanyId: client }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setMsg(t('pay.ord.approved')); await load(client);
    } catch (err) { setError((err as Error).message); }
  }

  const typeLabel = (ty: OrderType) => t(`pay.ord.type.${ty}` as never);

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{t('pay.ord.title')}</h1>
          {client && <button className={styles.primaryBtn} onClick={() => setOpen(true)}>{t('pay.ord.new')}</button>}
        </div>
        <PayrollTabs client={client} />
        {!client && <EmptyState message={t('pay.selectClient')} />}
        {msg && <p className={styles.hint} role="status">{msg}</p>}
        {client && error && <ErrorState message={error} onRetry={() => load(client)} />}

        {client && open && (
          <form className={styles.form} onSubmit={(e) => { e.preventDefault(); create(); }}>
            <label className={styles.field}><span>{t('pay.ord.type')}</span>
              <select value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)}>
                {(['bonus', 'vacation', 'wage_change', 'termination', 'hire'] as OrderType[]).map((ty) => (
                  <option key={ty} value={ty}>{typeLabel(ty)}</option>
                ))}
              </select></label>
            <label className={styles.field}><span>{t('pay.ord.employees')}</span>
              <select multiple={orderType === 'bonus'} value={orderType === 'bonus' ? employeeIds : (employeeIds[0] ?? '')}
                onChange={(e) => setEmployeeIds(orderType === 'bonus'
                  ? Array.from(e.target.selectedOptions, (o) => o.value)
                  : [e.target.value])}>
                {orderType !== 'bonus' && <option value="">—</option>}
                {emps.map((emp) => <option key={emp.id} value={emp.id}>{emp.lastName} {emp.firstName}</option>)}
              </select></label>
            {AMOUNT_TYPES.has(orderType) && (
              <label className={styles.field}><span>{t('pay.ord.amount')}</span>
                <input value={amount} onChange={(e) => setAmount(e.target.value)} required /></label>
            )}
            {RANGE_TYPES.has(orderType) && (
              <>
                <label className={styles.field}><span>{t('pay.ord.from')}</span>
                  <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} required /></label>
                <label className={styles.field}><span>{t('pay.ord.to')}</span>
                  <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} required /></label>
              </>
            )}
            {orderType === 'termination' && (
              <label className={`${styles.field} ${styles.checkField}`}>
                <input type="checkbox" checked={severance} onChange={(e) => setSeverance(e.target.checked)} />
                <span>{t('pay.ord.severance')}</span></label>
            )}
            <label className={styles.field}><span>{t('pay.ord.effective')}</span>
              <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} required /></label>
            <label className={styles.field}><span>{t('pay.ord.reason')}</span>
              <input value={reason} onChange={(e) => setReason(e.target.value)} required /></label>
            <div className={styles.formActions}>
              <button className={styles.primaryBtn} type="submit">{t('pay.ord.create')}</button>
              <button className={styles.ghostBtn} type="button" onClick={() => setOpen(false)}>{t('pay.ord.cancel')}</button>
            </div>
          </form>
        )}

        {client && !error && loading && <div className={styles.skeletons}><SkeletonCard /></div>}
        {client && !error && !loading && orders && orders.length === 0 && (
          <EmptyState message={t('pay.ord.empty')} detail={t('pay.ord.emptyDetail')} />
        )}
        {client && !error && !loading && orders && orders.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead><tr>
                <th scope="col">{t('pay.ord.type')}</th><th scope="col">{t('pay.ord.effective')}</th>
                <th scope="col">{t('pay.ord.amount')}</th><th scope="col">{t('pay.ord.status')}</th>
                <th scope="col"><span className="sr-only">{t('pay.ord.approve')}</span></th>
              </tr></thead>
              <tbody>
                {orders.map((o) => (
                  <tr key={o.id}>
                    <td>{typeLabel(o.orderType)}</td>
                    <td className={styles.mono}>{o.effectiveDate}</td>
                    <td className={styles.num}>{o.amount ? formatDecimal(o.amount) : '—'}</td>
                    <td><span className={styles.statusChip}>{t(`pay.ord.status.${o.status}` as never)}</span></td>
                    <td className={styles.actionsCell}>
                      {o.status === 'draft'
                        ? <button className={styles.primaryBtn} onClick={() => approve(o.id)}>{t('pay.ord.approve')}</button>
                        : '—'}
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
  return <Suspense fallback={<div className={styles.skeletons}><SkeletonCard /></div>}><OrdersInner /></Suspense>;
}

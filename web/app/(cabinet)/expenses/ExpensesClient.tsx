'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import type { MsgKey } from '@/app/lib/i18n';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { formatCents } from '@/app/lib/format';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import { Toast } from '@/app/components/Toast';
import type { ToastKind } from '@/app/components/Toast';
import styles from './page.module.css';

const FIRM_ROLES = new Set(['accountant', 'firm_admin']);

interface ClaimRow {
  id: string; employeeId: string; employeeName: string; status: string; description: string; currency: string;
  totalNetCents: string; totalVatCents: string; totalCents: string;
  postingProposalId: string | null; journalEntryId: string | null; createdAt: string;
}

interface EmployeeOption { id: string; firstName: string; lastName: string; }

interface ExpenseSettingsResponse { mileageRateCentsPerKm: string; }

type LineKind = 'receipt' | 'mileage';

interface ComposerLine {
  kind: LineKind;
  lineDate: string;
  description: string;
  expenseAccount: string;
  net: string;
  vat: string;
  vatDeductible: boolean;
  documentId: string | null;
  km: string;
  uploading: boolean;
}

interface ToastEntry { id: number; message: string; kind: ToastKind; }

let toastCounter = 0;

const today = () => new Date().toISOString().slice(0, 10);

const emptyReceiptLine = (): ComposerLine => ({
  kind: 'receipt', lineDate: today(), description: '', expenseAccount: '7710',
  net: '0.00', vat: '0.00', vatDeductible: false, documentId: null, km: '', uploading: false,
});
const emptyMileageLine = (): ComposerLine => ({
  kind: 'mileage', lineDate: today(), description: '', expenseAccount: '7710',
  net: '', vat: '', vatDeductible: false, documentId: null, km: '0', uploading: false,
});

// Cent-safe preview of a composer line's gross amount (server recomputes authoritatively on
// save — this is display-only, mirrors bills/new's client-side VAT preview convention).
function lineGrossCents(l: ComposerLine, mileageRateCentsPerKm: number): number {
  if (l.kind === 'mileage') {
    const km = Number(l.km) || 0;
    return Math.round(km * mileageRateCentsPerKm);
  }
  const netCents = Math.round((Number(l.net) || 0) * 100);
  const vatCents = Math.round((Number(l.vat) || 0) * 100);
  return netCents + vatCents;
}

function toPayloadLine(l: ComposerLine) {
  if (l.kind === 'mileage') {
    return {
      kind: 'mileage' as const, lineDate: l.lineDate, description: l.description, expenseAccount: l.expenseAccount,
      km: (Number(l.km) || 0).toFixed(1), documentId: l.documentId,
    };
  }
  return {
    kind: 'receipt' as const, lineDate: l.lineDate, description: l.description, expenseAccount: l.expenseAccount,
    net: Math.max(0, Number(l.net) || 0).toFixed(2), vat: Math.max(0, Number(l.vat) || 0).toFixed(2),
    vatDeductible: l.vatDeductible, documentId: l.documentId,
  };
}

const STATUS_CLASS: Record<string, string | undefined> = {
  draft: styles.badgeDraft, submitted: styles.badgeSubmitted, approved: styles.badgeApproved,
  reimbursed: styles.badgeReimbursed, rejected: styles.badgeRejected,
};

function ExpensesInner({ role }: { role: string }) {
  const isFirm = FIRM_ROLES.has(role);
  const searchParams = useSearchParams();
  const client = searchParams.get('client');
  const { t, lang } = useMessages();

  const [rows, setRows] = useState<ClaimRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const [settings, setSettings] = useState<ExpenseSettingsResponse | null>(null);
  const [rateInput, setRateInput] = useState('');
  const [rateBusy, setRateBusy] = useState(false);
  const [rateError, setRateError] = useState<string | null>(null);

  const [employees, setEmployees] = useState<EmployeeOption[]>([]);

  const [composerOpen, setComposerOpen] = useState(false);
  const [composerEmployeeId, setComposerEmployeeId] = useState('');
  const [composerDescription, setComposerDescription] = useState('');
  const [lines, setLines] = useState<ComposerLine[]>([emptyReceiptLine()]);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [composerBusy, setComposerBusy] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);

  const [settleRow, setSettleRow] = useState<ClaimRow | null>(null);
  const [paidDate, setPaidDate] = useState(today());
  const [settleBusy, setSettleBusy] = useState(false);
  const [settleError, setSettleError] = useState<string | null>(null);

  function pushToast(message: string, kind: ToastKind) {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { id, message, kind }]);
  }
  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/expenses?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      const body = (await res.json()) as { claims?: ClaimRow[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setRows(body.claims ?? []);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadSettings = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/expenses/settings?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as ExpenseSettingsResponse;
      setSettings(body);
      setRateInput((Number(body.mileageRateCentsPerKm) / 100).toFixed(2));
    } catch {
      // Non-fatal — mileage lines just fall back to the last-known rate for preview.
    }
  }, []);

  useEffect(() => { if (client) load(client); }, [client, load]);
  useEffect(() => { if (client) loadSettings(client); }, [client, loadSettings]);

  useEffect(() => {
    if (!client || !isFirm) return;
    fetch(`/api/payroll/employees?clientCompanyId=${encodeURIComponent(client)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { employees: [] }))
      .then((d: { employees?: EmployeeOption[] }) => setEmployees(d.employees ?? []))
      .catch(() => setEmployees([]));
  }, [client, isFirm]);

  const mileageRateCentsPerKm = Number(settings?.mileageRateCentsPerKm ?? '30');

  const totals = useMemo(() => {
    let net = 0, vat = 0;
    for (const l of lines) {
      if (l.kind === 'mileage') {
        net += Math.round((Number(l.km) || 0) * mileageRateCentsPerKm);
      } else {
        net += Math.round((Number(l.net) || 0) * 100);
        vat += Math.round((Number(l.vat) || 0) * 100);
      }
    }
    return { netCents: net, vatCents: vat, grandCents: net + vat };
  }, [lines, mileageRateCentsPerKm]);

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

  const statusLabel = (s: string) => {
    const key = `exp.status.${s}` as MsgKey;
    const label = t(key);
    return label === key ? s : label;
  };

  // ── Composer ──────────────────────────────────────────────────────────────

  function openComposer() {
    setComposerEmployeeId('');
    setComposerDescription('');
    setLines([emptyReceiptLine()]);
    setComposerError(null);
    setComposerOpen(true);
  }

  function setLine(i: number, patch: Partial<ComposerLine>) {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function attachPhoto(i: number, file: File) {
    if (!client) return;
    setLine(i, { uploading: true });
    try {
      const form = new FormData();
      form.append('clientCompanyId', client);
      form.append('file', file);
      const res = await fetch('/api/expenses/upload', { method: 'POST', body: form });
      const body = (await res.json()) as { documentId?: string; suggestion?: { amount?: string; date?: string; merchant?: string }; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const s = body.suggestion ?? {};
      setLine(i, {
        uploading: false,
        documentId: body.documentId ?? null,
        net: s.amount ?? lines[i]!.net,
        lineDate: s.date ?? lines[i]!.lineDate,
        description: s.merchant ?? lines[i]!.description,
      });
    } catch (err) {
      setLine(i, { uploading: false });
      pushToast((err as Error).message ?? t('exp.composer.uploadFailed'), 'error');
    }
  }

  const composerValid = composerDescription.trim().length > 0
    && (!isFirm || composerEmployeeId)
    && lines.length > 0
    && lines.every((l) => (l.kind === 'receipt' ? l.net.trim().length > 0 : l.km.trim().length > 0));

  async function handleSave(submitAfter: boolean) {
    if (!client) return;
    if (!composerDescription.trim()) { setComposerError(t('state.error')); return; }
    if (isFirm && !composerEmployeeId) { setComposerError(t('exp.composer.employeeRequired')); return; }
    setComposerBusy(true);
    setComposerError(null);
    try {
      const res = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientCompanyId: client,
          employeeId: isFirm ? composerEmployeeId : undefined,
          description: composerDescription.trim(),
          lines: lines.map(toPayloadLine),
        }),
      });
      const body = (await res.json()) as { claimId?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (submitAfter && body.claimId) {
        const subRes = await fetch(`/api/expenses/${encodeURIComponent(body.claimId)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientCompanyId: client, action: 'submit' }),
        });
        const subBody = (await subRes.json()) as { error?: string };
        if (!subRes.ok) throw new Error(subBody.error ?? `HTTP ${subRes.status}`);
        pushToast(t('exp.composer.submitted'), 'ok');
      } else {
        pushToast(t('exp.composer.saved'), 'ok');
      }
      setComposerOpen(false);
      await load(client);
    } catch (err) {
      setComposerError((err as Error).message);
    } finally {
      setComposerBusy(false);
    }
  }

  // ── Row actions ───────────────────────────────────────────────────────────

  async function submitDraft(row: ClaimRow) {
    if (!client) return;
    try {
      const res = await fetch(`/api/expenses/${encodeURIComponent(row.id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, action: 'submit' }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      pushToast(t('exp.composer.submitted'), 'ok');
      await load(client);
    } catch (err) {
      pushToast((err as Error).message, 'error');
    }
  }

  async function deleteDraft(row: ClaimRow) {
    if (!client) return;
    if (!window.confirm(t('exp.confirmDelete'))) return;
    try {
      const res = await fetch(`/api/expenses/${encodeURIComponent(row.id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, action: 'delete' }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      await load(client);
    } catch (err) {
      pushToast((err as Error).message, 'error');
    }
  }

  function toggleSelect(id: string) {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function downloadOrder() {
    if (!client || selected.size === 0) { setOrderError(t('exp.reimburse.noneSelected')); return; }
    setOrderBusy(true);
    setOrderError(null);
    try {
      const res = await fetch('/api/expenses/payment-order', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, claimIds: [...selected] }),
      });
      const body = (await res.json()) as { xml?: string; total?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const blob = new Blob([body.xml ?? ''], { type: 'application/xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `expense-reimbursement-${today()}.xml`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setSelected(new Set());
    } catch (err) {
      setOrderError((err as Error).message);
    } finally {
      setOrderBusy(false);
    }
  }

  function openSettle(row: ClaimRow) {
    setSettleRow(row);
    setPaidDate(today());
    setSettleError(null);
  }

  async function submitSettle() {
    if (!settleRow || !client) return;
    setSettleBusy(true);
    setSettleError(null);
    try {
      const res = await fetch(`/api/expenses/${encodeURIComponent(settleRow.id)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, action: 'settle', paidDate }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSettleRow(null);
      await load(client);
    } catch (err) {
      setSettleError((err as Error).message);
    } finally {
      setSettleBusy(false);
    }
  }

  async function saveRate() {
    if (!client) return;
    const parsed = Number(rateInput.trim().replace(',', '.'));
    if (!Number.isFinite(parsed) || parsed <= 0) { setRateError(t('exp.settings.invalidRate')); return; }
    setRateBusy(true);
    setRateError(null);
    try {
      const res = await fetch('/api/expenses/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientCompanyId: client, mileageRateCentsPerKm: String(Math.round(parsed * 100)) }),
      });
      const body = (await res.json()) as ExpenseSettingsResponse & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSettings(body);
      pushToast(t('exp.settings.saved'), 'ok');
    } catch (err) {
      setRateError((err as Error).message);
    } finally {
      setRateBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{t('exp.title')}</h1>
          <button type="button" className={styles.primaryBtn} onClick={openComposer}>{t('exp.new')}</button>
        </div>

        {isFirm && (
          <div className={styles.settingsBox}>
            <span className={styles.settingsLabel}>{t('exp.settings.title')}</span>
            <label className={styles.settingsField}>
              {t('exp.settings.rate')}
              <input type="text" inputMode="decimal" value={rateInput} onChange={(e) => setRateInput(e.target.value)} />
            </label>
            <button type="button" className={styles.ghostBtn} onClick={saveRate} disabled={rateBusy}>{t('exp.settings.save')}</button>
            {rateError && <span className={styles.settleError}>{rateError}</span>}
          </div>
        )}

        {isFirm && (
          <div className={styles.reimburseBar}>
            <span>{t('exp.reimburse.selectApproved')}</span>
            <button type="button" className={styles.ghostBtn} onClick={downloadOrder} disabled={orderBusy || selected.size === 0}>
              {t('exp.reimburse.download')}
            </button>
            {orderError && <span className={styles.settleError}>{orderError}</span>}
          </div>
        )}

        {error && <ErrorState message={error} onRetry={() => client && load(client)} />}
        {!error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}
        {!error && !loading && rows && rows.length === 0 && (
          <EmptyState message={t('exp.empty')} detail={t('exp.emptyDetail')} />
        )}
        {!error && !loading && rows && rows.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {isFirm && <th scope="col" />}
                  {isFirm && <th scope="col">{t('exp.col.employee')}</th>}
                  <th scope="col">{t('exp.col.description')}</th>
                  <th scope="col">{t('exp.col.date')}</th>
                  <th scope="col" className={styles.colAmount}>{t('exp.col.total')}</th>
                  <th scope="col">{t('exp.col.status')}</th>
                  <th scope="col"><span className="sr-only">{t('exp.action.submit')}</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    {isFirm && (
                      <td>
                        {r.status === 'approved' && (
                          <input type="checkbox" checked={selected.has(r.id)} onChange={() => toggleSelect(r.id)} aria-label={r.description} />
                        )}
                      </td>
                    )}
                    {isFirm && <td>{r.employeeName}</td>}
                    <td>{r.description}</td>
                    <td>{fmtDate(r.createdAt)}</td>
                    <td className={styles.colAmount}>{formatCents(r.totalCents, r.currency) ?? '—'}</td>
                    <td><span className={`${styles.badge} ${STATUS_CLASS[r.status] ?? ''}`}>{statusLabel(r.status)}</span></td>
                    <td className={styles.actionsCell}>
                      {r.status === 'draft' && (
                        <>
                          <button type="button" className={styles.linkBtn} onClick={() => submitDraft(r)}>{t('exp.action.submit')}</button>
                          {' · '}
                          <button type="button" className={styles.linkBtn} onClick={() => deleteDraft(r)}>{t('exp.action.delete')}</button>
                        </>
                      )}
                      {isFirm && r.status === 'approved' && (
                        <button type="button" className={styles.linkBtn} onClick={() => openSettle(r)}>{t('exp.action.settle')}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {composerOpen && (
          <div className={styles.overlay} role="dialog" aria-modal="true" onClick={() => { if (!composerBusy) setComposerOpen(false); }}>
            <div className={styles.composerDrawer} onClick={(e) => e.stopPropagation()}>
              <h2>{t('exp.composer.title')}</h2>

              <div className={styles.composerFields}>
                {isFirm && (
                  <label className={styles.field}>
                    {t('exp.composer.employee')}
                    <select value={composerEmployeeId} onChange={(e) => setComposerEmployeeId(e.target.value)}>
                      <option value="">—</option>
                      {employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}
                    </select>
                  </label>
                )}
                <label className={styles.field}>
                  {t('exp.composer.description')}
                  <input value={composerDescription} onChange={(e) => setComposerDescription(e.target.value)} />
                </label>
              </div>

              <table className={styles.lineTable}>
                <thead>
                  <tr>
                    <th scope="col">{t('exp.composer.date')}</th>
                    <th scope="col">{t('exp.composer.lineDescription')}</th>
                    <th scope="col">{t('exp.composer.account')}</th>
                    <th scope="col" className={styles.right}>{t('exp.composer.net')} / {t('exp.composer.km')}</th>
                    <th scope="col" className={styles.right}>{t('exp.composer.vat')}</th>
                    <th scope="col">{t('exp.composer.deductible')}</th>
                    <th scope="col" className={styles.right}>{t('exp.composer.lineTotal')}</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td>
                        <input type="date" aria-label={t('exp.composer.date')} value={l.lineDate} onChange={(e) => setLine(i, { lineDate: e.target.value })} />
                      </td>
                      <td>
                        <input aria-label={t('exp.composer.lineDescription')} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} />
                        {l.kind === 'receipt' && (
                          <label className={styles.photoBtn}>
                            {l.uploading ? t('exp.composer.uploading') : t('exp.composer.attachPhoto')}
                            <input
                              type="file" accept="image/*,application/pdf" className={styles.hiddenInput}
                              disabled={l.uploading}
                              onChange={(e) => { const f = e.target.files?.[0]; if (f) attachPhoto(i, f); e.target.value = ''; }}
                            />
                          </label>
                        )}
                      </td>
                      <td>
                        <input aria-label={t('exp.composer.account')} value={l.expenseAccount} onChange={(e) => setLine(i, { expenseAccount: e.target.value })} className={styles.acct} />
                      </td>
                      <td className={styles.right}>
                        {l.kind === 'mileage' ? (
                          <input aria-label={t('exp.composer.km')} inputMode="decimal" value={l.km} onChange={(e) => setLine(i, { km: e.target.value })} className={styles.num} />
                        ) : (
                          <input aria-label={t('exp.composer.net')} inputMode="decimal" value={l.net} onChange={(e) => setLine(i, { net: e.target.value })} className={styles.num} />
                        )}
                      </td>
                      <td className={styles.right}>
                        {l.kind === 'receipt' ? (
                          <input aria-label={t('exp.composer.vat')} inputMode="decimal" value={l.vat} onChange={(e) => setLine(i, { vat: e.target.value })} className={styles.num} />
                        ) : (
                          <span className={styles.mutedCell}>{formatCents(String(Math.round((Number(l.km) || 0) * mileageRateCentsPerKm)), 'EUR')}</span>
                        )}
                      </td>
                      <td>
                        {l.kind === 'receipt' && (
                          <input type="checkbox" aria-label={t('exp.composer.deductible')} checked={l.vatDeductible} onChange={(e) => setLine(i, { vatDeductible: e.target.checked })} />
                        )}
                      </td>
                      <td className={styles.right}>{formatCents(String(lineGrossCents(l, mileageRateCentsPerKm)), 'EUR')}</td>
                      <td>
                        {lines.length > 1 && (
                          <button type="button" className={styles.ghostBtn} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>
                            {t('exp.composer.removeLine')}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className={styles.addLineRow}>
                <button type="button" className={styles.addLine} onClick={() => setLines((ls) => [...ls, emptyReceiptLine()])}>{t('exp.composer.addReceipt')}</button>
                <button type="button" className={styles.addLine} onClick={() => setLines((ls) => [...ls, emptyMileageLine()])}>{t('exp.composer.addMileage')}</button>
              </div>

              <div className={styles.totals}>
                <div><span>{t('exp.composer.totalNet')}</span><span className={styles.right}>{formatCents(String(totals.netCents), 'EUR')}</span></div>
                <div><span>{t('exp.composer.totalVat')}</span><span className={styles.right}>{formatCents(String(totals.vatCents), 'EUR')}</span></div>
                <div className={styles.grand}><span>{t('exp.composer.totalGrand')}</span><span className={styles.right}>{formatCents(String(totals.grandCents), 'EUR')}</span></div>
              </div>

              {composerError && <p className={styles.settleError}>{composerError}</p>}
              <div className={styles.drawerActions}>
                <button type="button" onClick={() => setComposerOpen(false)} disabled={composerBusy}>{t('exp.composer.cancel')}</button>
                <button type="button" className={styles.ghostBtn} disabled={!composerValid || composerBusy} onClick={() => handleSave(false)}>
                  {t('exp.composer.saveDraft')}
                </button>
                <button type="button" className={styles.primaryBtn} disabled={!composerValid || composerBusy} onClick={() => handleSave(true)}>
                  {t('exp.composer.submit')}
                </button>
              </div>
            </div>
          </div>
        )}

        {settleRow && (
          <div className={styles.overlay} role="dialog" aria-modal="true" onClick={() => { if (!settleBusy) setSettleRow(null); }}>
            <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
              <h2>{t('exp.settle.title')}</h2>
              <p>{settleRow.employeeName} — {formatCents(settleRow.totalCents, settleRow.currency)}</p>
              <label>
                {t('exp.settle.paidDate')}
                <input type="date" value={paidDate} onChange={(e) => setPaidDate(e.target.value)} />
              </label>
              {settleError && <p className={styles.settleError}>{settleError}</p>}
              <div className={styles.drawerActions}>
                <button type="button" onClick={() => setSettleRow(null)} disabled={settleBusy}>{t('exp.settle.cancel')}</button>
                <button type="button" className={styles.primaryBtn} onClick={submitSettle} disabled={settleBusy}>{t('exp.settle.submit')}</button>
              </div>
            </div>
          </div>
        )}
      </main>

      <div className={styles.toastRegion} aria-label={t('nav.notifications')}>
        {toasts.map((entry) => (
          <Toast key={entry.id} message={entry.message} kind={entry.kind} onDismiss={() => dismissToast(entry.id)} />
        ))}
      </div>
    </div>
  );
}

function ExpensesSkeleton() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>
      </main>
    </div>
  );
}

export function ExpensesClient({ role }: { role: string }) {
  return (
    <Suspense fallback={<ExpensesSkeleton />}>
      <ExpensesInner role={role} />
    </Suspense>
  );
}

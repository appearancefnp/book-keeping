'use client';

import { useState } from 'react';
import { useMessages } from '@/app/lib/i18n-context';
import { formatCents } from '@/app/lib/format';
import styles from './TariffTable.module.css';

export interface FirmTariffRow {
  clientCompanyId: string;
  clientName: string;
  monthlyAmountCents: string | null;
  currency: string | null;
  vatRate: string | null;
  effectiveFrom: string | null;
}

interface TariffTableProps {
  tariffs: FirmTariffRow[];
  role: string;
  onSaved: () => void;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function TariffTable({ tariffs, role, onSaved }: TariffTableProps) {
  const { t } = useMessages();
  const [editing, setEditing] = useState<string | null>(null);
  const canEdit = role === 'firm_admin';

  return (
    <section className={styles.section} aria-labelledby="tariffs-heading">
      <h2 id="tariffs-heading" className={styles.heading}>{t('admin.tariffs.title')}</h2>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('admin.tariffs.client')}</th>
            <th scope="col" className={styles.num}>{t('admin.tariffs.retainer')}</th>
            <th scope="col" className={styles.num}>{t('admin.tariffs.vat')}</th>
            <th scope="col">{t('admin.tariffs.effectiveFrom')}</th>
            {canEdit && <th aria-hidden="true" />}
          </tr>
        </thead>
        <tbody>
          {tariffs.map((row) => (
            editing === row.clientCompanyId ? (
              <tr key={row.clientCompanyId}>
                <td colSpan={canEdit ? 5 : 4}>
                  <TariffForm
                    row={row}
                    onCancel={() => setEditing(null)}
                    onSaved={() => { setEditing(null); onSaved(); }}
                  />
                </td>
              </tr>
            ) : (
              <tr key={row.clientCompanyId}>
                <td>{row.clientName}</td>
                <td className={styles.num}>
                  {row.monthlyAmountCents
                    ? (formatCents(row.monthlyAmountCents, row.currency ?? 'EUR') ?? '—')
                    : <span className={styles.muted}>{t('admin.tariffs.notSet')}</span>}
                </td>
                <td className={styles.num}>{row.vatRate ? `${row.vatRate}%` : '—'}</td>
                <td>{row.effectiveFrom ?? '—'}</td>
                {canEdit && (
                  <td>
                    <button type="button" onClick={() => setEditing(row.clientCompanyId)}>
                      {t('admin.tariffs.edit')}
                    </button>
                  </td>
                )}
              </tr>
            )
          ))}
        </tbody>
      </table>
    </section>
  );
}

function TariffForm({ row, onCancel, onSaved }: {
  row: FirmTariffRow; onCancel: () => void; onSaved: () => void;
}) {
  const { t } = useMessages();
  const [amount, setAmount] = useState(
    row.monthlyAmountCents ? (Number(row.monthlyAmountCents) / 100).toFixed(2) : '',
  );
  const [currency, setCurrency] = useState(row.currency ?? 'EUR');
  const [vatRate, setVatRate] = useState(row.vatRate ?? '21');
  const [effectiveFrom, setEffectiveFrom] = useState(row.effectiveFrom ?? todayIso());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  async function save() {
    const n = Number(amount);
    if (amount.trim() === '' || Number.isNaN(n) || n < 0) { setError(true); return; }
    setSaving(true);
    setError(false);
    try {
      const cents = Math.round(n * 100);
      const res = await fetch('/api/admin/tariffs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientCompanyId: row.clientCompanyId,
          monthlyAmountCents: String(cents),
          currency,
          vatRate,
          effectiveFrom,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onSaved();
    } catch {
      setError(true);
      setSaving(false);
    }
  }

  return (
    <div>
      <div className={styles.form}>
        <label className={styles.field}>{t('admin.tariffs.amount')}
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className={styles.field}>{t('admin.tariffs.currency')}
          <input value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
        </label>
        <label className={styles.field}>{t('admin.tariffs.vat')}
          <input inputMode="decimal" value={vatRate} onChange={(e) => setVatRate(e.target.value)} />
        </label>
        <label className={styles.field}>{t('admin.tariffs.effectiveFrom')}
          <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        </label>
        <div className={styles.actions}>
          <button type="button" onClick={save} disabled={saving}>{t('admin.tariffs.save')}</button>
          <button type="button" onClick={onCancel} disabled={saving}>{t('admin.tariffs.cancel')}</button>
        </div>
      </div>
      {error && <p className={styles.error} role="alert">{t('admin.tariffs.saveError')}</p>}
    </div>
  );
}

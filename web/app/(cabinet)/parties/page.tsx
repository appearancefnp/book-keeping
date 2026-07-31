'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useMessages } from '@/app/lib/i18n-context';
import { SkeletonCard } from '@/app/components/SkeletonCard';
import { ErrorState } from '@/app/components/ErrorState';
import { EmptyState } from '@/app/components/EmptyState';
import styles from './page.module.css';

type PartyKind = 'customer' | 'vendor' | 'both';
interface PartyRow {
  id: string; kind: PartyKind; name: string; regNo: string | null; vatNo: string | null;
  paymentTermsDays: number | null; countryCode: string;
}
interface FormState {
  id: string | null; kind: PartyKind; name: string; regNo: string; vatNo: string;
  paymentTermsDays: string; countryCode: string;
}

const EMPTY_FORM: FormState = { id: null, kind: 'customer', name: '', regNo: '', vatNo: '', paymentTermsDays: '', countryCode: 'LV' };

function PartiesInner() {
  const searchParams = useSearchParams();
  const { t } = useMessages();
  const clientCompanyId = searchParams.get('client');

  const [parties, setParties] = useState<PartyRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/parties?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { parties: PartyRow[] };
      setParties(body.parties);
    } catch (err) {
      setError((err as Error).message ?? t('state.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  async function save() {
    if (!clientCompanyId || !form || !form.name.trim()) return;
    setSaving(true);
    setSaveError(null);
    const payload = {
      clientCompanyId,
      kind: form.kind,
      name: form.name.trim(),
      regNo: form.regNo.trim() || null,
      vatNo: form.vatNo.trim() || null,
      countryCode: /^[A-Za-z]{2}$/.test(form.countryCode.trim()) ? form.countryCode.trim().toUpperCase() : 'LV',
      paymentTermsDays: form.paymentTermsDays.trim() ? Number(form.paymentTermsDays.trim()) : null,
    };
    try {
      const res = await fetch(form.id ? `/api/parties/${form.id}` : '/api/parties', {
        method: form.id ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setForm(null);
      await load(clientCompanyId);
    } catch (err) {
      setSaveError((err as Error).message ?? t('state.error'));
    } finally {
      setSaving(false);
    }
  }

  const kindLabel = (k: PartyKind) =>
    k === 'customer' ? t('parties.kind.customer') : k === 'vendor' ? t('parties.kind.vendor') : t('parties.kind.both');

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.headRow}>
          <h1 className={styles.pageHeading}>{t('parties.title')}</h1>
          <button type="button" className={styles.primaryBtn} onClick={() => { setSaveError(null); setForm({ ...EMPTY_FORM }); }}>
            {t('parties.new')}
          </button>
        </div>

        {form && (
          <form className={styles.form} onSubmit={(e) => { e.preventDefault(); save(); }}>
            <label className={styles.field}>
              <span>{t('parties.name')}</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </label>
            <label className={styles.field}>
              <span>{t('parties.kind')}</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as PartyKind })}>
                <option value="customer">{t('parties.kind.customer')}</option>
                <option value="vendor">{t('parties.kind.vendor')}</option>
                <option value="both">{t('parties.kind.both')}</option>
              </select>
            </label>
            <label className={styles.field}>
              <span>{t('parties.regNo')}</span>
              <input value={form.regNo} onChange={(e) => setForm({ ...form, regNo: e.target.value })} />
            </label>
            <label className={styles.field}>
              <span>{t('parties.vatNo')}</span>
              <input value={form.vatNo} onChange={(e) => setForm({ ...form, vatNo: e.target.value })} />
            </label>
            <label className={styles.field}>
              <span>{t('party.countryCode')}</span>
              <input
                value={form.countryCode}
                maxLength={2}
                className={styles.countryInput}
                onChange={(e) => setForm({ ...form, countryCode: e.target.value.toUpperCase() })}
              />
            </label>
            {(form.kind === 'customer' || form.kind === 'both') && (
              <label className={styles.field}>
                <span>{t('parties.paymentTerms')}</span>
                <input
                  type="number"
                  min={0}
                  max={365}
                  value={form.paymentTermsDays}
                  onChange={(e) => setForm({ ...form, paymentTermsDays: e.target.value })}
                />
              </label>
            )}
            {saveError && <p className={styles.formError} role="alert">{saveError}</p>}
            <div className={styles.formActions}>
              <button type="submit" className={styles.primaryBtn} disabled={saving || !form.name.trim()}>
                {t('parties.save')}
              </button>
              <button type="button" className={styles.ghostBtn} onClick={() => setForm(null)}>
                {t('parties.cancel')}
              </button>
            </div>
          </form>
        )}

        {error && <ErrorState message={error} onRetry={() => clientCompanyId && load(clientCompanyId)} />}
        {!error && loading && <div className={styles.skeletons}><SkeletonCard /><SkeletonCard /></div>}
        {!error && !loading && parties && parties.length === 0 && (
          <EmptyState message={t('parties.empty')} detail={t('parties.emptyDetail')} />
        )}
        {!error && !loading && parties && parties.length > 0 && (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('parties.name')}</th>
                  <th scope="col">{t('parties.kind')}</th>
                  <th scope="col">{t('parties.regNo')}</th>
                  <th scope="col">{t('parties.vatNo')}</th>
                  <th scope="col"><span className="sr-only">{t('parties.edit')}</span></th>
                </tr>
              </thead>
              <tbody>
                {parties.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{kindLabel(p.kind)}</td>
                    <td className={styles.mono}>{p.regNo ?? '—'}</td>
                    <td className={styles.mono}>{p.vatNo ?? '—'}</td>
                    <td className={styles.actionsCell}>
                      <button
                        type="button"
                        className={styles.ghostBtn}
                        onClick={() => {
                          setSaveError(null);
                          setForm({
                            id: p.id,
                            kind: p.kind,
                            name: p.name,
                            regNo: p.regNo ?? '',
                            vatNo: p.vatNo ?? '',
                            countryCode: p.countryCode || 'LV',
                            paymentTermsDays: p.paymentTermsDays != null ? String(p.paymentTermsDays) : '',
                          });
                        }}
                      >
                        {t('parties.edit')}
                      </button>
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

function PartiesSkeleton() {
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
    <Suspense fallback={<PartiesSkeleton />}>
      <PartiesInner />
    </Suspense>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { useMessages } from '@/app/lib/i18n-context';
import type { MsgKey } from '@/app/lib/i18n';
import { LOCALE_FOR } from '@/app/lib/i18n';
import { EmptyState } from '@/app/components/EmptyState';
import styles from './page.module.css';

interface FeedAccountRow { id: string; providerAccountId: string; iban: string; currency: string; lastSyncedDate: string | null }
interface FeedConnectionRow {
  id: string; provider: string; providerRequisitionId: string; institutionId: string; institutionName: string;
  status: string; consentExpiresAt: string | null; lastError: string; createdAt: string; accounts: FeedAccountRow[];
}
interface Institution { id: string; name: string; logoUrl?: string }

const EXPIRY_WARN_DAYS = 14;

export function FeedsSection({ clientCompanyId }: { clientCompanyId: string }) {
  const { t, lang } = useMessages();
  const [connections, setConnections] = useState<FeedConnectionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // connection id or 'connect'
  const [picking, setPicking] = useState(false);
  const [institutions, setInstitutions] = useState<Institution[] | null>(null);
  const [chosen, setChosen] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/bank/connections?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { connections?: FeedConnectionRow[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setConnections(body.connections ?? []);
    } catch (err) { setError((err as Error).message); }
  }, [clientCompanyId]);

  useEffect(() => { load(); }, [load]);

  async function openPicker() {
    setPicking(true);
    if (institutions) return;
    try {
      const res = await fetch(`/api/bank/institutions?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as { institutions?: Institution[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setInstitutions(body.institutions ?? []);
    } catch (err) { setError((err as Error).message); setPicking(false); }
  }

  async function connect() {
    if (!chosen) return;
    setBusy('connect');
    setError(null);
    try {
      const inst = institutions?.find((i) => i.id === chosen);
      const res = await fetch('/api/bank/connections', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, institutionId: chosen, institutionName: inst?.name ?? chosen }),
      });
      const body = (await res.json().catch(() => ({}))) as { consentUrl?: string; error?: string };
      if (!res.ok || !body.consentUrl) throw new Error(body.error ?? `HTTP ${res.status}`);
      window.location.href = body.consentUrl;
    } catch (err) { setError((err as Error).message); setBusy(null); }
  }

  async function syncNow(id: string) {
    setBusy(id); setError(null); setMsg(null);
    try {
      const res = await fetch(`/api/bank/connections/${id}/sync`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId }),
      });
      const body = (await res.json().catch(() => ({}))) as
        { accounts?: { imported: number; skipped: number }[]; proposals?: number; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const imported = (body.accounts ?? []).reduce((n, a) => n + a.imported, 0);
      const skipped = (body.accounts ?? []).reduce((n, a) => n + a.skipped, 0);
      setMsg(t('bankfeed.synced')
        .replace('{imported}', String(imported)).replace('{skipped}', String(skipped))
        .replace('{proposals}', String(body.proposals ?? 0)));
      await load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  async function remove(id: string) {
    setBusy(id); setError(null);
    try {
      const res = await fetch(`/api/bank/connections/${id}?clientCompanyId=${encodeURIComponent(clientCompanyId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await load();
    } catch (err) { setError((err as Error).message); } finally { setBusy(null); }
  }

  const fmtDate = (iso: string) =>
    new Intl.DateTimeFormat(LOCALE_FOR[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  const statusLabel = (s: string) => {
    const key = `bankfeed.status.${s}` as MsgKey;
    const label = t(key);
    return label === key ? s : label;
  };
  const expiresSoon = (c: FeedConnectionRow) =>
    c.consentExpiresAt !== null &&
    new Date(c.consentExpiresAt).getTime() - Date.now() < EXPIRY_WARN_DAYS * 86_400_000;

  return (
    <section className={styles.card} aria-labelledby="feeds-heading">
      <h2 id="feeds-heading" className={styles.sectionHeading}>{t('bankfeed.title')}</h2>
      <p className={styles.hint}>{t('bankfeed.hint')}</p>
      {error && <p className={styles.formError} role="alert">{error}</p>}
      {msg && <p className={styles.okMsg} role="status">{msg}</p>}

      {connections && connections.length === 0 && !picking && (
        <EmptyState message={t('bankfeed.empty')} detail={t('bankfeed.emptyDetail')} />
      )}

      {connections?.map((c) => (
        <div key={c.id} className={styles.paymentRow}>
          <div>
            <strong>{c.institutionName}</strong> — {statusLabel(c.status)}
            {c.accounts.map((a) => (
              <div key={a.id} className={styles.hint}>
                {a.iban} · {a.lastSyncedDate
                  ? t('bankfeed.lastSynced').replace('{date}', fmtDate(a.lastSyncedDate))
                  : t('bankfeed.neverSynced')}
              </div>
            ))}
            {c.consentExpiresAt && c.status === 'linked' && (
              <div className={styles.hint}>
                {(expiresSoon(c) ? t('bankfeed.expiresSoon') : t('bankfeed.expires'))
                  .replace('{date}', fmtDate(c.consentExpiresAt))}
              </div>
            )}
            {c.lastError && <p className={styles.formError} role="alert">{c.lastError}</p>}
          </div>
          <div className={styles.formActions}>
            {c.status === 'linked' && (
              <button type="button" className={styles.primaryBtn} onClick={() => syncNow(c.id)} disabled={busy !== null}>
                {busy === c.id ? t('state.loading') : t('bankfeed.syncNow')}
              </button>
            )}
            {(c.status === 'expired' || c.status === 'revoked') && (
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={() => { setChosen(c.institutionId); openPicker(); }}
                disabled={busy !== null}
              >
                {t('bankfeed.reconnect')}
              </button>
            )}
            <button type="button" className={styles.ghostBtn} onClick={() => remove(c.id)} disabled={busy !== null}>
              {t('bankfeed.remove')}
            </button>
          </div>
        </div>
      ))}

      {picking ? (
        <div className={styles.formActions}>
          <label className={styles.field}>
            <span>{t('bankfeed.institution')}</span>
            <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
              <option value="">{t('bankfeed.choosePrompt')}</option>
              {(institutions ?? []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </label>
          <button type="button" className={styles.primaryBtn} onClick={connect} disabled={!chosen || busy !== null}>
            {busy === 'connect' ? t('state.loading') : t('bankfeed.start')}
          </button>
          <button type="button" className={styles.ghostBtn} onClick={() => setPicking(false)} disabled={busy !== null}>
            {t('bankfeed.cancel')}
          </button>
        </div>
      ) : (
        <div className={styles.formActions}>
          <button type="button" className={styles.primaryBtn} onClick={openPicker} disabled={busy !== null}>{t('bankfeed.connect')}</button>
        </div>
      )}
    </section>
  );
}

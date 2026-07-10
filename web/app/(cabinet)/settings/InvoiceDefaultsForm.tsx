'use client';

import { useCallback, useEffect, useState } from 'react';
import { useMessages } from '@/app/lib/i18n-context';
import styles from './page.module.css';

interface DefaultLineDraft { description: string; net: string; vatRate: string; }
interface InvoiceProfileDTO {
  paymentTerms: string | null;
  note: string | null;
  dueDateOffsetDays: number | null;
  numberPrefix: string | null;
  defaultLines: { description: string; net: string; vatRate: number }[];
  footer: string | null;
  logoBlobKey: string | null;
}

export function InvoiceDefaultsForm({ clientCompanyId }: { clientCompanyId: string }) {
  const { t } = useMessages();
  const [loaded, setLoaded] = useState(false);
  const [paymentTerms, setPaymentTerms] = useState('');
  const [note, setNote] = useState('');
  const [dueOffset, setDueOffset] = useState('');
  const [prefix, setPrefix] = useState('');
  const [footer, setFooter] = useState('');
  const [hasLogo, setHasLogo] = useState(false);
  const [lines, setLines] = useState<DefaultLineDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'saved' | 'error'; message: string } | null>(null);

  const load = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/invoice-profile?clientCompanyId=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { profile: InvoiceProfileDTO | null };
      const p = body.profile;
      setPaymentTerms(p?.paymentTerms ?? '');
      setNote(p?.note ?? '');
      setDueOffset(p?.dueDateOffsetDays != null ? String(p.dueDateOffsetDays) : '');
      setPrefix(p?.numberPrefix ?? '');
      setFooter(p?.footer ?? '');
      setHasLogo(Boolean(p?.logoBlobKey));
      setLines((p?.defaultLines ?? []).map((l) => ({ description: l.description, net: l.net, vatRate: String(l.vatRate) })));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (clientCompanyId) load(clientCompanyId);
  }, [clientCompanyId, load]);

  async function save() {
    if (!clientCompanyId) return;
    setBusy(true);
    setStatus(null);
    try {
      // Preserve explicit 0 (due-on-issue); only blank/invalid → null.
      const offsetDays = (() => {
        const s = String(dueOffset).trim();
        if (s === '') return null;
        const n = Number(s);
        return Number.isInteger(n) && n >= 0 ? n : null;
      })();

      const profile = {
        paymentTerms: paymentTerms.trim() || null,
        note: note.trim() || null,
        dueDateOffsetDays: offsetDays,
        numberPrefix: prefix.trim() || null,
        footer: footer.trim() || null,
        defaultLines: lines
          .filter((l) => l.description.trim())
          .map((l) => ({ description: l.description.trim(), net: l.net.trim() || '0', vatRate: Number(l.vatRate) || 0 })),
      };
      const res = await fetch('/api/invoice-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, profile }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setStatus({ kind: 'saved', message: t('settings.invoice.saved') });
    } catch {
      setStatus({ kind: 'error', message: t('settings.invoice.error') });
    } finally {
      setBusy(false);
    }
  }

  async function uploadLogo(file: File) {
    if (!clientCompanyId) return;
    setBusy(true);
    setStatus(null);
    try {
      const bytesBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('read failed'));
        reader.onload = () => {
          const result = String(reader.result);
          resolve(result.slice(result.indexOf(',') + 1)); // strip the data: URI prefix
        };
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/invoice-profile/logo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientCompanyId, bytesBase64, mime: file.type }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      setHasLogo(true);
      setStatus({ kind: 'saved', message: t('settings.invoice.logoUploaded') });
    } catch {
      setStatus({ kind: 'error', message: t('settings.invoice.error') });
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  return (
    <section className={styles.card} aria-labelledby="invoice-defaults-heading">
      <h2 id="invoice-defaults-heading" className={styles.sectionHeading}>{t('settings.invoice.title')}</h2>
      <form onSubmit={(e) => { e.preventDefault(); save(); }} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <div className={styles.inlineForm}>
          <label className={styles.field}>
            <span>{t('settings.invoice.paymentTerms')}</span>
            <input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>{t('settings.invoice.note')}</span>
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>{t('settings.invoice.dueOffset')}</span>
            <input inputMode="numeric" value={dueOffset} onChange={(e) => setDueOffset(e.target.value)} />
          </label>
          <label className={styles.field}>
            <span>{t('settings.invoice.prefix')}</span>
            <input value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          </label>
        </div>

        <label className={styles.field}>
          <span>{t('settings.invoice.footer')}</span>
          <textarea value={footer} onChange={(e) => setFooter(e.target.value)} rows={3} />
        </label>

        <label className={styles.field}>
          <span>{t('settings.invoice.logo')}{hasLogo ? ' ✓' : ''}</span>
          <input
            type="file"
            accept="image/*"
            disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadLogo(f); e.target.value = ''; }}
          />
        </label>

        <div>
          <h3 className={styles.sectionHeading}>{t('settings.invoice.lines')}</h3>
          {lines.length > 0 && (
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">{t('settings.invoice.desc')}</th>
                    <th scope="col" className={styles.colAmount}>{t('settings.invoice.net')}</th>
                    <th scope="col" className={styles.colAmount}>{t('settings.invoice.vat')}</th>
                    <th scope="col"><span className="sr-only">{t('einv.line.remove')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          aria-label={t('settings.invoice.desc')}
                          value={l.description}
                          onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                        />
                      </td>
                      <td className={styles.colAmount}>
                        <input
                          aria-label={t('settings.invoice.net')}
                          inputMode="decimal"
                          value={l.net}
                          onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, net: e.target.value } : x)))}
                        />
                      </td>
                      <td className={styles.colAmount}>
                        <input
                          aria-label={t('settings.invoice.vat')}
                          inputMode="numeric"
                          value={l.vatRate}
                          onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, vatRate: e.target.value } : x)))}
                        />
                      </td>
                      <td className={styles.actionsCell}>
                        <button
                          type="button"
                          className={styles.ghostBtn}
                          onClick={() => setLines(lines.filter((_, j) => j !== i))}
                        >
                          {t('einv.line.remove')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <button
            type="button"
            className={styles.ghostBtn}
            onClick={() => setLines([...lines, { description: '', net: '', vatRate: '21' }])}
          >
            {t('settings.invoice.addLine')}
          </button>
        </div>

        {status && (
          <p
            className={status.kind === 'error' ? styles.formError : styles.hint}
            role={status.kind === 'error' ? 'alert' : 'status'}
          >
            {status.message}
          </p>
        )}
        <div>
          <button type="submit" className={styles.primaryBtn} disabled={busy}>
            {t('settings.invoice.save')}
          </button>
        </div>
      </form>
    </section>
  );
}

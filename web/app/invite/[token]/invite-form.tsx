'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import QRCode from 'qrcode';
import { useMessages } from '@/app/lib/i18n-context';
import styles from './invite.module.css';

type Status = 'loading' | 'invalid' | 'form' | 'done';

interface InvitePreview {
  email: string;
  firmName: string;
  otpauthUri: string;
  totpSecret: string;
}

export function InviteForm({ token }: { token: string }) {
  const { t } = useMessages();

  const [status, setStatus] = useState<Status>('loading');
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/auth/invite/${encodeURIComponent(token)}`, { cache: 'no-store' });
        if (!res.ok) throw new Error('invalid');
        const data = (await res.json()) as InvitePreview;
        if (cancelled) return;
        setPreview(data);
        const qr = await QRCode.toDataURL(data.otpauthUri);
        if (cancelled) return;
        setQrDataUrl(qr);
        setStatus('form');
      } catch {
        if (!cancelled) setStatus('invalid');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/invite/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, totpCode }),
      });
      if (!res.ok) throw new Error('invalid');
      setStatus('done');
    } catch {
      // Every failure mode — expired, invalid, wrong code, network error —
      // surfaces the same generic message; never reveals which one happened.
      setStatus('invalid');
    } finally {
      setBusy(false);
    }
  }

  if (status === 'loading') {
    return (
      <p className={styles.status} aria-live="polite">
        {t('state.loading')}
      </p>
    );
  }

  if (status === 'invalid') {
    return (
      <p className={styles.status} aria-live="polite">
        {t('invite.invalid')}
      </p>
    );
  }

  if (status === 'done') {
    return (
      <div className={styles.fields}>
        <h1 className={styles.title}>{t('invite.title')}</h1>
        <p className={styles.status} aria-live="polite">
          {t('invite.done')}
        </p>
        <Link href="/login" className={styles.btn}>
          {t('invite.goLogin')}
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className={styles.fields}>
        <h1 className={styles.title}>{t('invite.title')}</h1>
        <p className={styles.intro}>{t('invite.intro')}</p>

        <div className={styles.field}>
          <span className={styles.label}>{t('invite.firm')}</span>
          <span className={styles.readonly}>{preview!.firmName}</span>
        </div>
        <div className={styles.field}>
          <span className={styles.label}>{t('invite.email')}</span>
          <span className={styles.readonly}>{preview!.email}</span>
        </div>

        <div className={styles.field}>
          <label htmlFor="invite-password" className={styles.label}>
            {t('invite.password')}
          </label>
          <input
            id="invite-password"
            type="password"
            className={styles.input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
            disabled={busy}
          />
          <span className={styles.hint}>{t('invite.passwordHint')}</span>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>{t('invite.scan')}</span>
          {qrDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrDataUrl} alt={t('invite.scan')} className={styles.qr} />
          )}
          <span className={styles.hint}>{t('invite.manualSecret')}</span>
          <code className={styles.secret}>{preview!.totpSecret}</code>
        </div>

        <div className={styles.field}>
          <label htmlFor="invite-code" className={styles.label}>
            {t('invite.code')}
          </label>
          <input
            id="invite-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            className={styles.input}
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
            required
            disabled={busy}
          />
        </div>

        <button
          type="submit"
          className={styles.btn}
          disabled={busy || password.length < 12 || totpCode.length !== 6}
        >
          {busy ? '…' : t('invite.activate')}
        </button>
      </div>
    </form>
  );
}

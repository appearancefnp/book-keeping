'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { login } from '@/app/lib/api-client';
import { useMessages } from '@/app/lib/i18n-context';
import styles from './login.module.css';

type Step = 'credentials' | 'code';

export function LoginForm() {
  const { t } = useMessages();
  const router = useRouter();

  const [step, setStep] = useState<Step>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStep('code');
  }

  async function handleCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password, code);
      router.push('/');
    } catch (err) {
      const e = err as Error & { status?: number };
      // The backend returns one generic 401 for every failure (no password-vs-2FA
      // oracle), so the client can't and shouldn't say which factor was wrong.
      // Stay on the code step — a mistyped code is the common case — with a neutral
      // message; "Back" returns to credentials if the email/password were wrong.
      setError(e.status === 401 ? t('login.failed') : (e.message ?? t('state.error')));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {step === 'credentials' ? (
        <form onSubmit={handleCredentials} noValidate>
          <div className={styles.fields}>
            <div className={styles.field}>
              <label htmlFor="login-email" className={styles.label}>
                {t('login.email')}
              </label>
              <input
                id="login-email"
                type="email"
                className={styles.input}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                autoFocus
                required
                disabled={busy}
              />
            </div>
            <div className={styles.field}>
              <label htmlFor="login-password" className={styles.label}>
                {t('login.password')}
              </label>
              <input
                id="login-password"
                type="password"
                className={styles.input}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                disabled={busy}
              />
            </div>
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <button type="submit" className={styles.btn} disabled={busy || !email || !password}>
              {t('login.submit')}
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={handleCode} noValidate>
          <div className={styles.fields}>
            <div className={styles.field}>
              <label htmlFor="login-code" className={styles.label}>
                {t('login.code')}
              </label>
              <input
                id="login-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                className={styles.input}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                autoFocus
                required
                disabled={busy}
              />
            </div>
            {error && (
              <p className={styles.error} role="alert">
                {error}
              </p>
            )}
            <button
              type="submit"
              className={styles.btn}
              disabled={busy || code.length !== 6}
            >
              {busy ? '…' : t('login.verify')}
            </button>
            <button
              type="button"
              className={styles.backLink}
              onClick={() => {
                setStep('credentials');
                setError(null);
                setCode('');
              }}
              disabled={busy}
            >
              {t('login.back')}
            </button>
          </div>
        </form>
      )}
    </>
  );
}

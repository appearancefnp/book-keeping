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
      if (e.status === 401) {
        const msg = e.message ?? '';
        // Surface the right message based on what the backend returns
        if (msg.includes('2FA') || msg.includes('Invalid 2FA')) {
          setError(t('login.badCode'));
        } else {
          // Could be wrong creds — go back to step 1
          setError(t('login.badCreds'));
          setStep('credentials');
          setCode('');
        }
      } else {
        setError(e.message ?? t('login.badCode'));
      }
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
          </div>
        </form>
      )}
    </>
  );
}

'use client';

import { useMessages } from '../lib/i18n-context';
import styles from './ErrorState.module.css';

export interface ErrorStateProps {
  message?: string;
  onRetry: () => void;
}

export function ErrorState({ message, onRetry }: ErrorStateProps) {
  const { t } = useMessages();
  return (
    <div className={styles.root} role="alert">
      <span className={styles.icon} aria-hidden="true">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <circle cx="20" cy="20" r="18" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M20 13v9"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
          <circle cx="20" cy="26.5" r="1.25" fill="currentColor" />
        </svg>
      </span>
      <h2 className={styles.heading}>{t('state.errorTitle')}</h2>
      <p className={styles.body}>{t('state.errorDetail')}</p>
      {message && (
        <p className={styles.detail}>{message}</p>
      )}
      <button
        type="button"
        className={styles.btnRetry}
        onClick={onRetry}
      >
        {t('state.retry')}
      </button>
    </div>
  );
}

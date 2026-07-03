'use client';

import { useMessages } from '../lib/i18n-context';
import styles from './LoadMoreButton.module.css';

export interface LoadMoreButtonProps {
  onClick: () => void;
  busy?: boolean;
}

export function LoadMoreButton({ onClick, busy = false }: LoadMoreButtonProps) {
  const { t } = useMessages();
  return (
    <div className={styles.row}>
      <button
        type="button"
        className={styles.btn}
        onClick={onClick}
        disabled={busy}
        aria-busy={busy}
      >
        {busy ? t('state.loading') : t('state.loadMore')}
      </button>
    </div>
  );
}

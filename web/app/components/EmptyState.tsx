import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  message?: string;
  detail?: string;
}

export function EmptyState({
  message = 'Nothing awaiting approval.',
  detail = "You're all caught up for this client.",
}: EmptyStateProps = {}) {
  return (
    <div className={styles.root} role="status">
      <span className={styles.icon} aria-hidden="true">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
          <circle cx="20" cy="20" r="18" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M13 20.5l4.5 4.5 9.5-10"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <h2 className={styles.heading}>{message}</h2>
      {detail && <p className={styles.body}>{detail}</p>}
    </div>
  );
}

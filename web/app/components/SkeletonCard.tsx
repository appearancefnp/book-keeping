import styles from './SkeletonCard.module.css';

export function SkeletonCard() {
  return (
    <div className={styles.card} aria-hidden="true" aria-label="Loading proposal">
      {/* Header row */}
      <div className={styles.header}>
        <div className={styles.barShort} />
        <div className={styles.barTiny} />
      </div>
      {/* Payload lines */}
      <div className={styles.body}>
        <div className={styles.barFull} />
        <div className={styles.barFull} />
        <div className={styles.barMid} />
      </div>
      {/* Rationale block */}
      <div className={styles.rationale}>
        <div className={styles.barShort} />
        <div className={styles.barFull} />
        <div className={styles.barMid} />
      </div>
      {/* Actions */}
      <div className={styles.actions}>
        <div className={styles.btnPlaceholder} />
        <div className={styles.btnPlaceholderSecondary} />
      </div>
    </div>
  );
}

import styles from './DetailList.module.css';

export interface DetailRow {
  label: string;
  value: string;
  /** Mono value (account codes, references). */
  mono?: boolean;
  /** Divider + heavier weight above this row — for totals like "Net payable". */
  total?: boolean;
}

export function DetailList({ rows, caption }: { rows: DetailRow[]; caption?: string }) {
  return (
    <div className={styles.root}>
      {caption && <p className={styles.caption}>{caption}</p>}
      <dl className={styles.list}>
        {rows.map((row, i) => (
          <div
            key={i}
            className={[styles.row, row.total ? styles.totalRow : ''].filter(Boolean).join(' ')}
          >
            <dt className={styles.label}>{row.label}</dt>
            <dd className={[styles.value, row.mono ? styles.mono : ''].filter(Boolean).join(' ')}>
              {row.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

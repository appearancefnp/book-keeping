import styles from './FigureRows.module.css';

export interface FigureRow {
  label: string;
  value: string;
}

export function FigureRows({ rows, caption }: { rows: FigureRow[]; caption?: string }) {
  return (
    <div className={styles.root}>
      {caption && <p className={styles.caption}>{caption}</p>}
      <dl className={styles.list}>
        {rows.map((row, i) => (
          <div key={i} className={styles.row}>
            <dt className={styles.label}>{row.label}</dt>
            <dd className={styles.value}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

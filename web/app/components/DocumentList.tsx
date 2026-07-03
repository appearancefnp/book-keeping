import type { DocumentStatus } from '@domain/documents/documents.js';
import { useMessages } from '@/app/lib/i18n-context';
import { EmptyState } from './EmptyState';
import styles from './DocumentList.module.css';

export interface DocumentRow {
  id: string;
  mime: string;
  status: DocumentStatus;
  source: string;
  storageKey: string;
  partyId: string | null;
  journalEntryId: string | null;
  extractedData: unknown | null;
}

const STATUS_TOKEN: Record<DocumentStatus, string> = {
  received: 'var(--ink-soft)',
  extracting: 'var(--attention)',
  extracted: 'var(--ok)',
  needs_review: 'var(--attention)',
  posted: 'var(--ok)',
  rejected: 'var(--danger)',
};

const STATUS_I18N_KEY: Record<DocumentStatus, `docs.status.${DocumentStatus}`> = {
  received: 'docs.status.received',
  extracting: 'docs.status.extracting',
  extracted: 'docs.status.extracted',
  needs_review: 'docs.status.needs_review',
  posted: 'docs.status.posted',
  rejected: 'docs.status.rejected',
};

function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

function mimeLabel(mime: string): string {
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('image/')) return mime.replace('image/', '').toUpperCase();
  return mime;
}

interface StatusChipProps {
  status: DocumentStatus;
}

function StatusChip({ status }: StatusChipProps) {
  const { t } = useMessages();
  const color = STATUS_TOKEN[status];
  return (
    <span
      className={styles.chip}
      style={{ '--chip-color': color } as React.CSSProperties}
    >
      <span className={styles.chipDot} aria-hidden="true" />
      <span>{t(STATUS_I18N_KEY[status])}</span>
    </span>
  );
}

interface DocumentListProps {
  documents: DocumentRow[];
}

export function DocumentList({ documents }: DocumentListProps) {
  const { t } = useMessages();

  if (documents.length === 0) {
    return <EmptyState message={t('docs.empty')} />;
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col" className={styles.thId}>ID</th>
            <th scope="col" className={styles.thType}>Type</th>
            <th scope="col" className={styles.thStatus}>Status</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc, i) => (
            <tr
              key={doc.id}
              className={styles.row}
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <td className={styles.tdId}>
                <code className={styles.idCode}>{shortId(doc.id)}</code>
              </td>
              <td className={styles.tdType}>{mimeLabel(doc.mime)}</td>
              <td className={styles.tdStatus}>
                <StatusChip status={doc.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

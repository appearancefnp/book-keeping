'use client';

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

// Defensive read of the AI extraction (ExtractedInvoice shape) — older or
// unprocessed documents have none, and the table must not depend on it.
interface ExtractedSummary {
  supplierName?: string;
  date?: string;
  amount?: string;
}

function extractedSummary(data: unknown): ExtractedSummary {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const obj = data as Record<string, unknown>;
  const out: ExtractedSummary = {};
  if (typeof obj['supplierName'] === 'string' && obj['supplierName']) out.supplierName = obj['supplierName'];
  if (typeof obj['date'] === 'string' && obj['date']) out.date = obj['date'];
  if (typeof obj['grandTotal'] === 'string' && obj['grandTotal']) {
    const currency = typeof obj['currency'] === 'string' ? obj['currency'] : '';
    const num = Number(obj['grandTotal']);
    out.amount = isNaN(num)
      ? `${obj['grandTotal']}${currency ? ` ${currency}` : ''}`
      : new Intl.NumberFormat('lv-LV', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(num) + (currency ? ` ${currency}` : '');
  }
  return out;
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
    return <EmptyState message={t('docs.empty')} detail={t('docs.emptyDetail')} />;
  }

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col" className={styles.thSupplier}>{t('rat.supplier')}</th>
            <th scope="col" className={styles.thDate}>{t('post.date')}</th>
            <th scope="col" className={styles.thAmount}>{t('bank.amount')}</th>
            <th scope="col" className={styles.thType}>{t('docs.col.type')}</th>
            <th scope="col" className={styles.thStatus}>{t('docs.col.status')}</th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc, i) => {
            const extracted = extractedSummary(doc.extractedData);
            return (
              <tr
                key={doc.id}
                className={styles.row}
                style={{ animationDelay: `${i * 40}ms` }}
              >
                <td className={styles.tdSupplier}>
                  {extracted.supplierName ?? (
                    <code className={styles.idCode}>{shortId(doc.id)}</code>
                  )}
                </td>
                <td className={styles.tdDate}>
                  {extracted.date ?? <span className={styles.nil}>—</span>}
                </td>
                <td className={styles.tdAmount}>
                  {extracted.amount ?? <span className={styles.nil}>—</span>}
                </td>
                <td className={styles.tdType}>{mimeLabel(doc.mime)}</td>
                <td className={styles.tdStatus}>
                  <StatusChip status={doc.status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

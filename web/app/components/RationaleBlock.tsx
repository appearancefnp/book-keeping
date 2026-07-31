'use client';

import type { Rationale } from '../lib/proposal-types';
import { useMessages } from '../lib/i18n-context';
import type { MsgKey } from '../lib/i18n';
import styles from './RationaleBlock.module.css';

// Defensive parse of sourceRefs (unknown)
function parseSourceRefs(sourceRefs: unknown): {
  confidence?: number;
  flags?: string[];
  rest: Record<string, unknown>;
} {
  if (!sourceRefs || typeof sourceRefs !== 'object' || Array.isArray(sourceRefs)) {
    return { rest: {} };
  }
  const obj = sourceRefs as Record<string, unknown>;
  const confidence =
    typeof obj['confidence'] === 'number' ? obj['confidence'] : undefined;
  const flags = Array.isArray(obj['flags'])
    ? (obj['flags'] as unknown[]).filter((f): f is string => typeof f === 'string')
    : undefined;
  // Spread everything for display, including confidence/flags
  return { confidence, flags, rest: obj };
}

function isLowConfidence(confidence?: number, flags?: string[]): boolean {
  if (typeof confidence === 'number' && confidence < 0.8) return true;
  if (flags && flags.includes('low_confidence')) return true;
  return false;
}

// Message keys for the source fields an accountant actually reads.
const SOURCE_LABEL_KEYS: Record<string, MsgKey> = {
  supplier: 'rat.supplier',
  counterparty: 'rat.counterparty',
  customer: 'rat.customer',
  invoiceRef: 'rat.invoice',
  invoiceNo: 'rat.invoice',
  confidence: 'rat.confidence',
};

function humanizeLabel(key: string, t: (k: MsgKey) => string): string {
  const msgKey = SOURCE_LABEL_KEYS[key];
  if (msgKey) return t(msgKey);
  const spaced = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Turn the machine-oriented sourceRefs into readable rows.
// Drops opaque identifiers (documentId, candidateEntryId, …), nulls, and nested
// structures the accountant has no use for — the opposite of a raw JSON dump.
function humanizeSourceRefs(
  sourceRefs: unknown,
  t: (k: MsgKey) => string,
): { label: string; value: string }[] {
  if (!sourceRefs || typeof sourceRefs !== 'object' || Array.isArray(sourceRefs)) return [];
  const obj = sourceRefs as Record<string, unknown>;
  const rows: { label: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(obj)) {
    if (key === 'flags') continue; // surfaced as the "Needs review" chip
    if (raw === null || raw === undefined || raw === '') continue;
    if (/id$/i.test(key)) continue; // opaque UUIDs — not for humans
    // Flatten one level so period/rule objects render as rows instead of vanishing: the ECSL
    // card's sourceRefs is entirely object-valued, so it previously showed nothing at all.
    // Arrays and deeper nesting stay dropped — a rows[] dump is not what this panel is for.
    if (typeof raw === 'object') {
      if (Array.isArray(raw)) continue;
      for (const [subKey, subRaw] of Object.entries(raw as Record<string, unknown>)) {
        if (subRaw === null || subRaw === undefined || subRaw === '') continue;
        if (typeof subRaw === 'object') continue;
        if (/id$/i.test(subKey)) continue;
        rows.push({
          label: `${humanizeLabel(key, t)} — ${humanizeLabel(subKey, t)}`,
          value: String(subRaw),
        });
      }
      continue;
    }
    if (key === 'confidence' && typeof raw === 'number') {
      rows.push({ label: t('rat.confidence'), value: `${Math.round(raw * 100)}%` });
      continue;
    }
    rows.push({ label: humanizeLabel(key, t), value: String(raw) });
  }
  return rows;
}

export function RationaleBlock({ rationale }: { rationale: Rationale }) {
  const { t } = useMessages();
  const { ruleRef, computation, sourceRefs } = rationale;
  const { confidence, flags } = parseSourceRefs(sourceRefs);
  const lowConf = isLowConfidence(confidence, flags);
  const sourceRows = humanizeSourceRefs(sourceRefs, t);

  const hasContent = ruleRef || computation || sourceRows.length > 0;

  return (
    <aside className={styles.root} aria-label={t('rat.title')}>
      <div className={styles.header}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" className={styles.headerIcon}>
          <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M4 5h6M4 7.5h4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
        </svg>
        <span className={styles.headerLabel}>{t('rat.title')}</span>
        {lowConf && (
          <span className={styles.attentionChip}>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.25"/>
              <path d="M6 3.5V6.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
              <circle cx="6" cy="8.5" r="0.625" fill="currentColor"/>
            </svg>
            {t('rat.needsReview')}
          </span>
        )}
      </div>

      {!hasContent && (
        <p className={styles.empty}>{t('rat.none')}</p>
      )}

      {ruleRef && (
        <div className={styles.field}>
          <dt className={styles.fieldLabel}>{t('rat.rule')}</dt>
          <dd className={styles.fieldValue}>
            <code className={styles.ruleCode}>{ruleRef}</code>
          </dd>
        </div>
      )}

      {computation && (
        <div className={styles.field}>
          <dt className={styles.fieldLabel}>{t('rat.computation')}</dt>
          <dd className={styles.fieldValue}>
            <p className={styles.computationText}>{computation}</p>
          </dd>
        </div>
      )}

      {sourceRows.length > 0 && (
        <div className={styles.field}>
          <dt className={styles.fieldLabel}>{t('rat.sources')}</dt>
          <dd className={styles.fieldValue}>
            <ul className={styles.sourceList}>
              {sourceRows.map((row, i) => (
                <li key={i} className={styles.sourceItem}>
                  <span className={styles.sourceKey}>{row.label}</span>
                  <span className={styles.sourceVal}>{row.value}</span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
    </aside>
  );
}

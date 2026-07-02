import type { Rationale } from '../lib/proposal-types';
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

function renderSourceRefs(sourceRefs: unknown): string {
  try {
    return JSON.stringify(sourceRefs, null, 2);
  } catch {
    return String(sourceRefs);
  }
}

export function RationaleBlock({ rationale }: { rationale: Rationale }) {
  const { ruleRef, computation, sourceRefs } = rationale;
  const { confidence, flags } = parseSourceRefs(sourceRefs);
  const lowConf = isLowConfidence(confidence, flags);

  const hasContent = ruleRef || computation || sourceRefs !== undefined;

  return (
    <aside className={styles.root} aria-label="AI reasoning">
      <div className={styles.header}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" className={styles.headerIcon}>
          <rect x="1" y="1" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M4 5h6M4 7.5h4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
        </svg>
        <span className={styles.headerLabel}>AI reasoning</span>
        {lowConf && (
          <span className={styles.attentionChip}>
            <svg aria-hidden="true" width="12" height="12" viewBox="0 0 12 12" fill="none">
              <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.25"/>
              <path d="M6 3.5V6.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round"/>
              <circle cx="6" cy="8.5" r="0.625" fill="currentColor"/>
            </svg>
            Needs review
          </span>
        )}
      </div>

      {!hasContent && (
        <p className={styles.empty}>No reasoning provided.</p>
      )}

      {ruleRef && (
        <div className={styles.field}>
          <dt className={styles.fieldLabel}>Rule</dt>
          <dd className={styles.fieldValue}>
            <code className={styles.ruleCode}>{ruleRef}</code>
          </dd>
        </div>
      )}

      {computation && (
        <div className={styles.field}>
          <dt className={styles.fieldLabel}>Computation</dt>
          <dd className={styles.fieldValue}>
            <p className={styles.computationText}>{computation}</p>
          </dd>
        </div>
      )}

      {sourceRefs !== undefined && (
        <div className={styles.field}>
          <dt className={styles.fieldLabel}>Sources</dt>
          <dd className={styles.fieldValue}>
            <pre className={styles.sourcesPre}>{renderSourceRefs(sourceRefs)}</pre>
          </dd>
        </div>
      )}
    </aside>
  );
}

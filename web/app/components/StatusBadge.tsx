'use client';

import type { ProposalType } from '../lib/proposal-types';
import { useMessages } from '../lib/i18n-context';
import type { MsgKey } from '../lib/i18n';
import styles from './StatusBadge.module.css';

const TYPE_META: Record<ProposalType, { labelKey: MsgKey; icon: string }> = {
  posting: {
    labelKey: 'type.posting',
    icon: '▪',
  },
  bank_match: {
    labelKey: 'type.bank_match',
    icon: '◆',
  },
  declaration: {
    labelKey: 'type.declaration',
    icon: '▸',
  },
  task: {
    labelKey: 'type.task',
    icon: '○',
  },
  ecsl: {
    labelKey: 'type.ecsl',
    icon: '▹',
  },
  recurring_invoice: {
    labelKey: 'type.recurring_invoice',
    icon: '↻',
  },
};

// A fallback for any proposal type not (yet) in TYPE_META — the server is the source of
// truth for `type`, and the API response is cast rather than validated (see proposal-types.ts),
// so a new type landing on the server before the UI knows about it must render something
// neutral instead of throwing (meta.icon on undefined) and crashing the whole approval queue.
const FALLBACK_META: { labelKey: MsgKey; icon: string } = {
  labelKey: 'type.unknown',
  icon: '●',
};

export function StatusBadge({ type }: { type: ProposalType }) {
  const { t } = useMessages();
  const meta = TYPE_META[type] ?? FALLBACK_META;
  return (
    <span className={styles.badge}>
      <span aria-hidden="true" className={styles.icon}>{meta.icon}</span>
      <span className={styles.label}>{t(meta.labelKey)}</span>
    </span>
  );
}

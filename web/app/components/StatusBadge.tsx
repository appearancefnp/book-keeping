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
};

export function StatusBadge({ type }: { type: ProposalType }) {
  const { t } = useMessages();
  const meta = TYPE_META[type];
  return (
    <span className={styles.badge}>
      <span aria-hidden="true" className={styles.icon}>{meta.icon}</span>
      <span className={styles.label}>{t(meta.labelKey)}</span>
    </span>
  );
}

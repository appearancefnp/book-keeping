import type { ProposalType } from '../lib/proposal-types';
import styles from './StatusBadge.module.css';

const TYPE_META: Record<ProposalType, { label: string; icon: string }> = {
  posting: {
    label: 'Posting',
    icon: '▪',
  },
  bank_match: {
    label: 'Bank match',
    icon: '◆',
  },
  declaration: {
    label: 'Declaration',
    icon: '▸',
  },
  task: {
    label: 'Task',
    icon: '○',
  },
};

export function StatusBadge({ type }: { type: ProposalType }) {
  const meta = TYPE_META[type];
  return (
    <span className={styles.badge}>
      <span aria-hidden="true" className={styles.icon}>{meta.icon}</span>
      <span className={styles.label}>{meta.label}</span>
    </span>
  );
}

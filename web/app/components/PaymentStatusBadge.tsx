'use client';

import type { ReceivableStatus } from '@domain/receivables/receivables.js';
import { useMessages } from '../lib/i18n-context';
import type { MsgKey } from '../lib/i18n';
import styles from './PaymentStatusBadge.module.css';

const CLASS_FOR: Record<ReceivableStatus, string> = {
  open: styles.open!,
  partially_paid: styles.partial!,
  paid: styles.paid!,
  void: styles.void!,
};

export function PaymentStatusBadge({ status }: { status: ReceivableStatus }) {
  const { t } = useMessages();
  return (
    <span className={`${styles.badge} ${CLASS_FOR[status]}`}>
      {t(`pay.status.${status}` as MsgKey)}
    </span>
  );
}

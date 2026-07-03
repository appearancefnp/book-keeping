'use client';

import type { BankMatchPayload } from '../lib/proposal-types';
import { formatCents } from '../lib/format';
import { useMessages } from '../lib/i18n-context';
import { DetailList, type DetailRow } from './DetailList';

export function BankMatchDetails({ payload }: { payload: BankMatchPayload }) {
  const { t } = useMessages();
  const amount = formatCents(payload.amountCents);

  const rows: DetailRow[] = [];
  if (payload.bankAccount) rows.push({ label: t('bank.account'), value: payload.bankAccount, mono: true });
  if (payload.receivablesAccount)
    rows.push({ label: t('bank.receivable'), value: payload.receivablesAccount, mono: true });
  if (amount) rows.push({ label: t('bank.amount'), value: amount, total: true });

  return (
    <DetailList
      caption={t('bank.caption')}
      rows={rows}
    />
  );
}

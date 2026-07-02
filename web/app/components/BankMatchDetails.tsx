import type { BankMatchPayload } from '../lib/proposal-types';
import { formatCents } from '../lib/format';
import { DetailList, type DetailRow } from './DetailList';

export function BankMatchDetails({ payload }: { payload: BankMatchPayload }) {
  const amount = formatCents(payload.amountCents);

  const rows: DetailRow[] = [];
  if (payload.bankAccount) rows.push({ label: 'Bank account', value: payload.bankAccount, mono: true });
  if (payload.receivablesAccount)
    rows.push({ label: 'Receivable settled', value: payload.receivablesAccount, mono: true });
  if (amount) rows.push({ label: 'Amount', value: amount, total: true });

  return (
    <DetailList
      caption="Settle an incoming bank payment against an open receivable."
      rows={rows}
    />
  );
}

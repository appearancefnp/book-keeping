'use client';

import type { DeclarationPayload } from '../lib/proposal-types';
import { formatDecimal, formatDateRange } from '../lib/format';
import { useMessages } from '../lib/i18n-context';
import { DetailList, type DetailRow } from './DetailList';

export function DeclarationDetails({ payload }: { payload: DeclarationPayload }) {
  const { t } = useMessages();
  const period = formatDateRange(payload.period?.fromDate, payload.period?.toDate);
  const outputVat = formatDecimal(payload.outputVat);
  const inputVat = formatDecimal(payload.inputVat);
  const netPayable = formatDecimal(payload.netPayable);
  const rate = payload.ruleRef?.value;

  const rows: DetailRow[] = [];
  if (period) rows.push({ label: t('decl.period'), value: period });
  if (outputVat) rows.push({ label: t('decl.outputVat'), value: outputVat });
  if (inputVat) rows.push({ label: t('decl.inputVat'), value: inputVat });
  if (netPayable) rows.push({ label: t('over.netPayable'), value: netPayable, total: true });

  const caption = rate
    ? t('decl.caption').replace('{rate}', String(rate))
    : t('decl.captionNoRate');

  return <DetailList caption={caption} rows={rows} />;
}

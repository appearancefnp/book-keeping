import type { DeclarationPayload } from '../lib/proposal-types';
import { formatDecimal, formatDateRange } from '../lib/format';
import { DetailList, type DetailRow } from './DetailList';

export function DeclarationDetails({ payload }: { payload: DeclarationPayload }) {
  const period = formatDateRange(payload.period?.fromDate, payload.period?.toDate);
  const outputVat = formatDecimal(payload.outputVat);
  const inputVat = formatDecimal(payload.inputVat);
  const netPayable = formatDecimal(payload.netPayable);
  const rate = payload.ruleRef?.value;

  const rows: DetailRow[] = [];
  if (period) rows.push({ label: 'Period', value: period });
  if (outputVat) rows.push({ label: 'Output VAT', value: outputVat });
  if (inputVat) rows.push({ label: 'Input VAT', value: inputVat });
  if (netPayable) rows.push({ label: 'Net VAT payable', value: netPayable, total: true });

  const caption = rate
    ? `VAT declaration at the ${rate}% standard rate.`
    : 'VAT declaration for the period.';

  return <DetailList caption={caption} rows={rows} />;
}

import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { computeVat, type VatConfig } from './vat-compute.js';
import { getTaxRate, type TaxRate } from './rules.js';

export interface VatDeclaration {
  period: { fromDate: string; toDate: string };
  outputVat: string; inputVat: string; netPayable: string;
  ruleRef: TaxRate;
}

function centsToDecimal(cents: string): string {
  const n = BigInt(cents);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

export async function assembleVatDeclaration(
  tx: PoolClient, ctx: TenantContext,
  args: { fromDate: string; toDate: string; config: VatConfig },
): Promise<VatDeclaration> {
  const v = await computeVat(tx, ctx, args);
  const ruleRef = await getTaxRate(tx, 'vat_standard_rate', args.toDate);
  return {
    period: { fromDate: args.fromDate, toDate: args.toDate },
    outputVat: centsToDecimal(v.outputVatCents),
    inputVat: centsToDecimal(v.inputVatCents),
    netPayable: centsToDecimal(v.netPayableCents),
    ruleRef,
  };
}

/** Representative EDS XML. Exact VID element names finalized in Plan 6 with tax-advisor input. */
export function toEdsXml(d: VatDeclaration): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<VatDeclaration>',
    `  <PeriodFrom>${d.period.fromDate}</PeriodFrom>`,
    `  <PeriodTo>${d.period.toDate}</PeriodTo>`,
    `  <OutputVat>${d.outputVat}</OutputVat>`,
    `  <InputVat>${d.inputVat}</InputVat>`,
    `  <NetPayable>${d.netPayable}</NetPayable>`,
    `  <RateRule type="${d.ruleRef.ruleType}" value="${d.ruleRef.value}" effectiveFrom="${d.ruleRef.effectiveFrom}"/>`,
    '</VatDeclaration>',
  ].join('\n');
}

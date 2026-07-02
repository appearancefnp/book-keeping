import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { computeVat, type VatConfig, type VatContribution } from './vat-compute.js';
import { getTaxRate, type TaxRate } from './rules.js';
import { centsToDecimal } from './money-format.js';

export async function explainVat(
  tx: PoolClient, ctx: TenantContext,
  args: { fromDate: string; toDate: string; config: VatConfig },
): Promise<{ netPayable: string; ruleRef: TaxRate; contributions: VatContribution[] }> {
  const v = await computeVat(tx, ctx, args);
  const ruleRef = await getTaxRate(tx, 'vat_standard_rate', args.toDate);
  return { netPayable: centsToDecimal(v.netPayableCents), ruleRef, contributions: v.contributions };
}

import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { assembleVatDeclaration, toEdsXml } from './vat-declaration.js';
import type { VatConfig } from './vat-compute.js';
import { resolveAutonomy } from '../autonomy/autonomy.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';
import { toCents } from '../db/money.js';

export async function createVatDeclarationProposal(
  tx: PoolClient, ctx: TenantContext,
  args: { fromDate: string; toDate: string; config: VatConfig },
): Promise<{ proposalId: string }> {
  const declaration = await assembleVatDeclaration(tx, ctx, args);
  const xml = toEdsXml(declaration);

  // Guardrail: declarations must ALWAYS require human approval — never auto-submit.
  const mode = await resolveAutonomy(tx, ctx, 'declaration', { amountCents: toCents(declaration.netPayable) });
  if (mode !== 'approval') throw new Error('declaration must require approval');

  const rationale = {
    ruleRef: declaration.ruleRef.ruleType,
    computation: `output ${declaration.outputVat} - input ${declaration.inputVat} = ${declaration.netPayable}`,
    sourceRefs: { period: declaration.period, rule: declaration.ruleRef },
    xml,
  } as Rationale;

  const { id } = await createProposal(tx, ctx, {
    type: 'declaration',
    payload: declaration,
    rationale,
    status: 'pending_approval',
  });
  return { proposalId: id };
}

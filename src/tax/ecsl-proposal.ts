import type { PoolClient } from 'pg';
import type { TenantContext } from '../tenancy/context.js';
import { ecSalesList, toPvn2Xml, type EcSalesList } from './ecsl.js';
import { getVatSettings } from './vat-settings.js';
import { resolveAutonomy } from '../autonomy/autonomy.js';
import { createProposal, type Rationale } from '../proposals/proposals.js';

/**
 * Prepare an EC Sales List (PVN 2) for approval. Like the VAT declaration, a filing may NEVER
 * auto-submit — the guardrail below is the same one createVatDeclarationProposal applies, and it
 * reuses the 'declaration' autonomy operation (autonomy_policy.operation_type is free text, so no
 * new operation or migration is needed).
 */
export async function createEcslProposal(
  tx: PoolClient, ctx: TenantContext, args: { fromDate: string; toDate: string },
): Promise<{ proposalId: string; list: EcSalesList }> {
  const list = await ecSalesList(tx, ctx, args);
  const settings = await getVatSettings(tx, ctx);
  const xml = toPvn2Xml(list, { vatNo: settings.vatNo });

  // Guardrail: a filing must ALWAYS require human approval — never auto-submit.
  const mode = await resolveAutonomy(tx, ctx, 'declaration', { amountCents: 0n });
  if (mode !== 'approval') throw new Error('declaration must require approval');

  const rationale = {
    ruleRef: 'ecsl-pvn2',
    computation: `${list.rows.length} counterparty row(s), total net ${list.totalNetCents} cents`,
    sourceRefs: { period: list.period, rows: list.rows, issues: list.issues },
    xml,
  } as Rationale;

  const { id } = await createProposal(tx, ctx, {
    type: 'ecsl', payload: list, rationale, status: 'pending_approval',
  });
  return { proposalId: id, list };
}
